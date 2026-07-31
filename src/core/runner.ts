/**
 * runner.ts
 *
 * run() — executes an agent against a user prompt and returns the final result.
 *
 * Convention:
 *   - `RunOptions` and `RunResult` use `type` — plain data shapes.
 *   - `RunEvent` uses `type` — it is a discriminated union of data variants.
 *
 * Phase 2: full tool-calling loop.
 *   send messages
 *     → model responds
 *     → tool calls requested? execute each, append results, loop back
 *     → finish reason "stop"? return final answer
 *     → maxTurns exceeded? return whatever we have
 */

import type { Agent } from "./agent.js";
import type { Message, ToolCallPart } from "./message.js";
import {
  systemMessage,
  userMessage,
  assistantTextMessage,
  assistantToolCallMessage,
  toolResultMessage,
} from "./message.js";
import type { GenerateResult, ToolCall } from "./provider.js";

// ── RunOptions ────────────────────────────────────────────────────────────────

export type RunOptions = {
  /**
   * Maximum number of model calls (including tool-call turns).
   * Prevents infinite loops when a model keeps requesting tools.
   * Default: 10
   */
  maxTurns?: number;
  /** Sampling temperature override (0–2). Undefined = provider default. */
  temperature?: number;
  /** Max tokens override. */
  maxTokens?: number;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
  /** Lifecycle hook — called for every internal event in the run. */
  onEvent?: (event: RunEvent) => void;
};

// ── RunEvent — discriminated union of every lifecycle event ───────────────────

export type RunEvent =
  // fired just before each model call
  | { type: "llm-call-start"; turn: number; messages: Message[] }
  // fired after the model responds, before any tool execution
  | { type: "llm-call-end"; turn: number; result: GenerateResult }
  // fired just before a single tool is executed
  | { type: "tool-call-start"; turn: number; toolName: string; args: unknown }
  // fired after a single tool returns its result
  | {
      type: "tool-call-end";
      turn: number;
      toolName: string;
      result: unknown;
      durationMs: number;
    }
  // fired once when the whole run is complete
  | { type: "run-complete"; finalOutput: string; turns: number };

// ── RunResult ─────────────────────────────────────────────────────────────────

export type RunResult = {
  /** The final plain-text answer from the model */
  finalOutput: string;
  /** Full conversation history including the final assistant message */
  messages: Message[];
  /** Number of model calls made */
  turns: number;
};

// ── run() ─────────────────────────────────────────────────────────────────────

/**
 * Run an agent against a user prompt and return the final result.
 *
 * The loop:
 *   1. Call the model with the current message history.
 *   2. If the model requests tool calls, execute each one, append the
 *      assistant turn + all tool results to history, and loop back.
 *   3. If the model returns a plain text "stop", return it as finalOutput.
 *   4. If maxTurns is exceeded, return whatever text we have so far.
 *
 * @example
 * ```ts
 * const result = await run(agent, "What's the weather in Tokyo?");
 * console.log(result.finalOutput);
 * ```
 */
export async function run(
  agent: Agent,
  input: string,
  options: RunOptions = {},
): Promise<RunResult> {
  const { maxTurns = 10, temperature, maxTokens, signal, onEvent } = options;

  // Build the initial message list
  const messages: Message[] = [
    systemMessage(agent.instructions),
    userMessage(input),
  ];

  // Build a quick lookup map so we can find tools by name in O(1)
  const toolMap = new Map(agent.tools.map((t) => [t.name, t]));

  let turns = 0;
  let finalOutput = "";

  while (turns < maxTurns) {
    turns++;

    // ── 1. Call the model ────────────────────────────────────────────────────
    onEvent?.({ type: "llm-call-start", turn: turns, messages: [...messages] });

    const result = await agent.model.generate({
      messages,
      tools: agent.tools.length > 0 ? agent.tools : undefined,
      temperature,
      maxTokens,
      signal,
    });

    onEvent?.({ type: "llm-call-end", turn: turns, result });

    // ── 2. No tool calls → we have the final answer ──────────────────────────
    if (result.toolCalls.length === 0) {
      finalOutput = result.text;
      messages.push(assistantTextMessage(result.text));
      break;
    }

    // ── 3. Tool calls → execute each one ────────────────────────────────────
    // First append the assistant's turn (which contains the tool-call
    // requests) so the model sees its own prior requests when we loop back.
    messages.push(
      assistantToolCallMessage(
        result.toolCalls.map(
          (tc): ToolCallPart => ({
            type: "tool-call",
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            args: tc.args,
          }),
        ),
        result.text, // carry any text the model emitted alongside tool calls
      ),
    );

    // Execute all tool calls in this turn (sequentially for now; Phase 5+
    // can parallelise them once we have observability sorted)
    for (const tc of result.toolCalls) {
      const toolResult = await executeTool(tc, toolMap, turns, onEvent, signal);

      // Append each tool result as its own message so the model gets them all
      messages.push(
        toolResultMessage(
          tc.toolCallId,
          tc.toolName,
          JSON.stringify(toolResult),
        ),
      );
    }

    // Safety: if we're about to exceed maxTurns, surface what we have
    if (turns >= maxTurns) {
      finalOutput = result.text;
      break;
    }

    // Loop back — the model will see the tool results and (usually) respond
    // with a plain text "stop" on the next turn
  }

  onEvent?.({ type: "run-complete", finalOutput, turns });

  return { finalOutput, messages, turns };
}

// ── executeTool() — internal helper ──────────────────────────────────────────

async function executeTool(
  tc: ToolCall,
  toolMap: Map<
    string,
    {
      name: string;
      parameters: { parse: (v: unknown) => unknown };
      execute: (args: unknown) => Promise<unknown>;
    }
  >,
  turn: number,
  onEvent: RunOptions["onEvent"],
  signal?: AbortSignal,
): Promise<unknown> {
  const tool = toolMap.get(tc.toolName);

  // Unknown tool — return a structured error so the model can self-correct
  // rather than crashing the whole run
  if (!tool) {
    const error = {
      error: `Unknown tool "${tc.toolName}". Available tools: ${[...toolMap.keys()].join(", ")}`,
    };
    onEvent?.({
      type: "tool-call-start",
      turn,
      toolName: tc.toolName,
      args: tc.args,
    });
    onEvent?.({
      type: "tool-call-end",
      turn,
      toolName: tc.toolName,
      result: error,
      durationMs: 0,
    });
    return error;
  }

  // Parse and validate args with Zod — gives us type safety and a clear
  // error message if the model hallucinated bad argument shapes
  let parsedArgs: unknown;
  try {
    const raw = JSON.parse(tc.args);
    parsedArgs = tool.parameters.parse(raw);
  } catch (err) {
    const error = {
      error: `Invalid arguments for tool "${tc.toolName}": ${err instanceof Error ? err.message : String(err)}`,
    };
    onEvent?.({
      type: "tool-call-start",
      turn,
      toolName: tc.toolName,
      args: tc.args,
    });
    onEvent?.({
      type: "tool-call-end",
      turn,
      toolName: tc.toolName,
      result: error,
      durationMs: 0,
    });
    return error;
  }

  onEvent?.({
    type: "tool-call-start",
    turn,
    toolName: tc.toolName,
    args: parsedArgs,
  });

  // Respect the AbortSignal — if the run was cancelled, don't start new work
  if (signal?.aborted) {
    throw new Error("Run aborted before tool execution.");
  }

  const start = Date.now();
  const result = await tool.execute(parsedArgs);
  const durationMs = Date.now() - start;

  onEvent?.({
    type: "tool-call-end",
    turn,
    toolName: tc.toolName,
    result,
    durationMs,
  });

  return result;
}
