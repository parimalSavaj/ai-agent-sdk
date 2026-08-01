/**
 * runner.ts
 *
 * run()       — executes an agent, returns a final result (non-streaming).
 * runStream() — executes an agent, yields StreamEvents as they arrive.
 *
 * Convention:
 *   - `RunOptions`, `RunResult`, `RunStreamEvent` use `type` — plain data.
 *   - `RunEvent` is a discriminated union of lifecycle variants.
 *
 * Phase 4: runStream() — normalized event stream across all providers,
 * with full tool-calling loop support inside the stream.
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
import type { GenerateResult, ToolCall, StreamEvent } from "./provider.js";

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
  | { type: "run-complete"; finalOutput: string; turns: number }; // ── RunResult ─────────────────────────────────────────────────────────────────

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

// ── RunStreamEvent — what runStream() yields to the caller ───────────────────
// A superset of provider StreamEvents plus lifecycle markers so the caller
// can observe exactly what's happening without needing onEvent.

export type RunStreamEvent =
  // Text token arriving from the model — pipe straight to stdout/UI
  | { type: "text-delta"; delta: string }
  // Tool call fully assembled (args complete) — about to be executed
  | { type: "tool-call-start"; turn: number; toolName: string; args: unknown }
  // Tool finished executing
  | {
      type: "tool-call-end";
      turn: number;
      toolName: string;
      result: unknown;
      durationMs: number;
    }
  // Model finished one turn (either stop or tool_calls)
  | { type: "turn-finish"; turn: number; finishReason: string }
  // Entire run complete — carries the same data as RunResult
  | { type: "finish"; finalOutput: string; messages: Message[]; turns: number };

// ── runStream() ───────────────────────────────────────────────────────────────

/**
 * Streaming version of run(). Returns an AsyncGenerator that yields
 * RunStreamEvents as they arrive from the model.
 *
 * Text deltas are yielded immediately — no buffering. Tool calls are
 * accumulated during the stream, executed after the stream finishes for
 * that turn, and then the next turn is streamed automatically.
 *
 * Falls back to generate() + a synthetic text-delta if the provider does
 * not implement stream().
 *
 * @example
 * ```ts
 * for await (const event of runStream(agent, "Tell me a joke")) {
 *   if (event.type === "text-delta") process.stdout.write(event.delta);
 *   if (event.type === "finish") console.log("\nDone:", event.finalOutput);
 * }
 * ```
 */
export async function* runStream(
  agent: Agent,
  input: string,
  options: RunOptions = {},
): AsyncGenerator<RunStreamEvent> {
  const { maxTurns = 10, temperature, maxTokens, signal, onEvent } = options;

  const messages: Message[] = [
    systemMessage(agent.instructions),
    userMessage(input),
  ];

  const toolMap = new Map(agent.tools.map((t) => [t.name, t]));

  let turns = 0;
  let finalOutput = "";

  while (turns < maxTurns) {
    turns++;

    onEvent?.({ type: "llm-call-start", turn: turns, messages: [...messages] });

    // ── Accumulate everything we need from this turn's stream ────────────────
    let turnText = "";
    const turnToolCalls: ToolCall[] = [];

    if (agent.model.stream) {
      // ── Provider supports streaming ───────────────────────────────────────
      const streamInput = {
        messages,
        tools: agent.tools.length > 0 ? agent.tools : undefined,
        temperature,
        maxTokens,
        signal,
      };

      // Partial tool-call accumulator keyed by toolCallId
      const partialTools = new Map<
        string,
        { toolName: string; args: string }
      >();

      for await (const event of agent.model.stream(streamInput)) {
        switch (event.type) {
          case "text-delta":
            turnText += event.delta;
            yield { type: "text-delta", delta: event.delta };
            break;

          case "tool-call-delta": {
            // Accumulate argument chunks — not yielded to caller individually
            const existing = partialTools.get(event.toolCallId);
            if (existing) {
              existing.args += event.delta;
            }
            break;
          }

          case "tool-call":
            // Fully assembled tool call — store for execution after stream ends
            partialTools.set(event.toolCallId, {
              toolName: event.toolName,
              args: event.args,
            });
            turnToolCalls.push({
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: event.args,
            });
            break;

          case "finish":
            yield {
              type: "turn-finish",
              turn: turns,
              finishReason: event.finishReason,
            };
            break;
        }
      }
    } else {
      // ── Fallback: provider only implements generate() ────────────────────
      const result = await agent.model.generate({
        messages,
        tools: agent.tools.length > 0 ? agent.tools : undefined,
        temperature,
        maxTokens,
        signal,
      });

      // Emit the full text as a single delta so the caller's switch still works
      if (result.text) {
        turnText = result.text;
        yield { type: "text-delta", delta: result.text };
      }

      for (const tc of result.toolCalls) {
        turnToolCalls.push(tc);
      }

      yield {
        type: "turn-finish",
        turn: turns,
        finishReason: result.finishReason,
      };

      onEvent?.({ type: "llm-call-end", turn: turns, result });
    }

    // ── No tool calls → this turn produced the final answer ──────────────────
    if (turnToolCalls.length === 0) {
      finalOutput = turnText;
      messages.push(assistantTextMessage(turnText));
      break;
    }

    // ── Tool calls → append assistant turn, execute, loop ────────────────────
    messages.push(
      assistantToolCallMessage(
        turnToolCalls.map(
          (tc): ToolCallPart => ({
            type: "tool-call",
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            args: tc.args,
          }),
        ),
        turnText,
      ),
    );

    for (const tc of turnToolCalls) {
      let parsedArgs: unknown = tc.args;
      try {
        parsedArgs = JSON.parse(tc.args);
      } catch {
        /* keep raw */
      }

      yield {
        type: "tool-call-start",
        turn: turns,
        toolName: tc.toolName,
        args: parsedArgs,
      };

      const toolResult = await executeTool(tc, toolMap, turns, onEvent, signal);

      yield {
        type: "tool-call-end",
        turn: turns,
        toolName: tc.toolName,
        result: toolResult,
        durationMs: 0, // already tracked inside executeTool via onEvent
      };

      messages.push(
        toolResultMessage(
          tc.toolCallId,
          tc.toolName,
          JSON.stringify(toolResult),
        ),
      );
    }

    if (turns >= maxTurns) {
      finalOutput = turnText;
      break;
    }
  }

  onEvent?.({ type: "run-complete", finalOutput, turns });

  yield { type: "finish", finalOutput, messages, turns };
}
