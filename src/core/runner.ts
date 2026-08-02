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
 * Phase 5: every RunEvent now carries a timestamp (ISO string) and the
 * agent name so observers have full context without needing to close over
 * anything. An optional `emitter` field in RunOptions enables subscription-
 * style observation alongside the existing inline `onEvent` callback.
 * Both are fired for every event — they compose, not replace each other.
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
import type { AgentEventEmitter } from "../events/emitter.js";
import type { Thread } from "./thread.js";

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
  /**
   * Inline lifecycle callback — fired for every event.
   * Composes with `emitter` when both are provided.
   */
  onEvent?: (event: RunEvent) => void;
  /**
   * Thread for conversation memory. When provided, the runner loads existing
   * messages from the thread before calling the model, and saves new messages
   * back after the run. Pass the same thread across multiple run() calls to
   * maintain a persistent conversation.
   *
   * @example
   * ```ts
   * const thread = createThread();
   * await run(agent, "My name is Alex", { thread });
   * const result = await run(agent, "What is my name?", { thread });
   * ```
   */
  thread?: Thread;
  /**
   * EventEmitter instance — fired for every event in addition to onEvent.
   * Enables multi-subscriber, reusable observability.
   *
   * @example
   * ```ts
   * const emitter = new AgentEventEmitter();
   * emitter.on("tool-call-end", (e) => metrics.record(e));
   * await run(agent, input, { emitter });
   * ```
   */
  emitter?: AgentEventEmitter;
};

// ── RunEvent — discriminated union of every lifecycle event ───────────────────
// Every variant now carries:
//   - timestamp : ISO-8601 string of when the event was fired
//   - agentName : name of the agent that produced it

export type RunEvent =
  | {
      type: "llm-call-start";
      agentName: string;
      turn: number;
      messages: Message[];
      timestamp: string;
    }
  | {
      type: "llm-call-end";
      agentName: string;
      turn: number;
      result: GenerateResult;
      /** Wall-clock ms the model call took */
      durationMs: number;
      timestamp: string;
    }
  | {
      type: "tool-call-start";
      agentName: string;
      turn: number;
      toolName: string;
      args: unknown;
      timestamp: string;
    }
  | {
      type: "tool-call-end";
      agentName: string;
      turn: number;
      toolName: string;
      result: unknown;
      durationMs: number;
      timestamp: string;
    }
  | {
      type: "run-complete";
      agentName: string;
      finalOutput: string;
      turns: number;
      /** Total wall-clock ms for the entire run */
      totalDurationMs: number;
      timestamp: string;
    };

// ── RunResult ─────────────────────────────────────────────────────────────────

export type RunResult = {
  /** The final plain-text answer from the model */
  finalOutput: string;
  /** Full conversation history including the final assistant message */
  messages: Message[];
  /** Number of model calls made */
  turns: number;
};

// ── Internal helper — fire both onEvent and emitter ──────────────────────────

function dispatch(
  event: RunEvent,
  onEvent?: (e: RunEvent) => void,
  emitter?: AgentEventEmitter,
): void {
  onEvent?.(event);
  emitter?.emit(event);
}

// ── run() ─────────────────────────────────────────────────────────────────────

/**
 * Run an agent against a user prompt and return the final result.
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
  const {
    maxTurns = 10,
    temperature,
    maxTokens,
    signal,
    onEvent,
    emitter,
    thread,
  } = options;

  // ── Build initial message list ────────────────────────────────────────────
  // System message always goes first (not stored in thread).
  // If a thread is provided, replay its history before the new user message.
  const messages: Message[] = [
    systemMessage(agent.instructions),
    ...(thread ? thread.getMessages() : []),
    userMessage(input),
  ];

  const toolMap = new Map(agent.tools.map((t) => [t.name, t]));

  // Track how many messages existed before this run so we only save new ones
  const messageCountBefore = messages.length;

  let turns = 0;
  let finalOutput = "";
  const runStart = Date.now();

  while (turns < maxTurns) {
    turns++;

    const llmStart = Date.now();

    dispatch(
      {
        type: "llm-call-start",
        agentName: agent.name,
        turn: turns,
        messages: [...messages],
        timestamp: new Date().toISOString(),
      },
      onEvent,
      emitter,
    );

    const result = await agent.model.generate({
      messages,
      tools: agent.tools.length > 0 ? agent.tools : undefined,
      temperature,
      maxTokens,
      signal,
    });

    dispatch(
      {
        type: "llm-call-end",
        agentName: agent.name,
        turn: turns,
        result,
        durationMs: Date.now() - llmStart,
        timestamp: new Date().toISOString(),
      },
      onEvent,
      emitter,
    );

    // No tool calls → final answer
    if (result.toolCalls.length === 0) {
      finalOutput = result.text;
      messages.push(assistantTextMessage(result.text));
      break;
    }

    // Tool calls → append assistant turn, execute, loop
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
        result.text,
      ),
    );

    for (const tc of result.toolCalls) {
      const toolResult = await executeTool(
        tc,
        toolMap,
        turns,
        agent.name,
        onEvent,
        emitter,
        signal,
      );
      messages.push(
        toolResultMessage(
          tc.toolCallId,
          tc.toolName,
          JSON.stringify(toolResult),
        ),
      );
    }

    if (turns >= maxTurns) {
      finalOutput = result.text;
      break;
    }
  }

  dispatch(
    {
      type: "run-complete",
      agentName: agent.name,
      finalOutput,
      turns,
      totalDurationMs: Date.now() - runStart,
      timestamp: new Date().toISOString(),
    },
    onEvent,
    emitter,
  );

  // Save new messages back to thread (everything added during this run)
  if (thread) {
    thread.addMessages(messages.slice(messageCountBefore));
  }

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
  agentName: string,
  onEvent: RunOptions["onEvent"],
  emitter: RunOptions["emitter"],
  signal?: AbortSignal,
): Promise<unknown> {
  const tool = toolMap.get(tc.toolName);

  if (!tool) {
    const error = {
      error: `Unknown tool "${tc.toolName}". Available tools: ${[...toolMap.keys()].join(", ")}`,
    };
    dispatch(
      {
        type: "tool-call-start",
        agentName,
        turn,
        toolName: tc.toolName,
        args: tc.args,
        timestamp: new Date().toISOString(),
      },
      onEvent,
      emitter,
    );
    dispatch(
      {
        type: "tool-call-end",
        agentName,
        turn,
        toolName: tc.toolName,
        result: error,
        durationMs: 0,
        timestamp: new Date().toISOString(),
      },
      onEvent,
      emitter,
    );
    return error;
  }

  // Parse and validate args with Zod
  let parsedArgs: unknown;
  try {
    const raw = JSON.parse(tc.args);
    parsedArgs = tool.parameters.parse(raw);
  } catch (err) {
    const error = {
      error: `Invalid arguments for tool "${tc.toolName}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
    dispatch(
      {
        type: "tool-call-start",
        agentName,
        turn,
        toolName: tc.toolName,
        args: tc.args,
        timestamp: new Date().toISOString(),
      },
      onEvent,
      emitter,
    );
    dispatch(
      {
        type: "tool-call-end",
        agentName,
        turn,
        toolName: tc.toolName,
        result: error,
        durationMs: 0,
        timestamp: new Date().toISOString(),
      },
      onEvent,
      emitter,
    );
    return error;
  }

  dispatch(
    {
      type: "tool-call-start",
      agentName,
      turn,
      toolName: tc.toolName,
      args: parsedArgs,
      timestamp: new Date().toISOString(),
    },
    onEvent,
    emitter,
  );

  if (signal?.aborted) {
    throw new Error("Run aborted before tool execution.");
  }

  const start = Date.now();
  const result = await tool.execute(parsedArgs);
  const durationMs = Date.now() - start;

  dispatch(
    {
      type: "tool-call-end",
      agentName,
      turn,
      toolName: tc.toolName,
      result,
      durationMs,
      timestamp: new Date().toISOString(),
    },
    onEvent,
    emitter,
  );

  return result;
}

// ── RunStreamEvent — what runStream() yields to the caller ───────────────────

export type RunStreamEvent =
  | { type: "text-delta"; delta: string }
  | { type: "tool-call-start"; turn: number; toolName: string; args: unknown }
  | {
      type: "tool-call-end";
      turn: number;
      toolName: string;
      result: unknown;
      durationMs: number;
    }
  | { type: "turn-finish"; turn: number; finishReason: string }
  | { type: "finish"; finalOutput: string; messages: Message[]; turns: number };

// ── runStream() ───────────────────────────────────────────────────────────────

/**
 * Streaming version of run(). Returns an AsyncGenerator that yields
 * RunStreamEvents as they arrive from the model.
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
  const {
    maxTurns = 10,
    temperature,
    maxTokens,
    signal,
    onEvent,
    emitter,
    thread,
  } = options;

  const messages: Message[] = [
    systemMessage(agent.instructions),
    ...(thread ? thread.getMessages() : []),
    userMessage(input),
  ];

  const toolMap = new Map(agent.tools.map((t) => [t.name, t]));
  const messageCountBefore = messages.length;

  let turns = 0;
  let finalOutput = "";
  const runStart = Date.now();

  while (turns < maxTurns) {
    turns++;

    const llmStart = Date.now();

    dispatch(
      {
        type: "llm-call-start",
        agentName: agent.name,
        turn: turns,
        messages: [...messages],
        timestamp: new Date().toISOString(),
      },
      onEvent,
      emitter,
    );

    let turnText = "";
    const turnToolCalls: ToolCall[] = [];

    if (agent.model.stream) {
      const streamInput = {
        messages,
        tools: agent.tools.length > 0 ? agent.tools : undefined,
        temperature,
        maxTokens,
        signal,
      };

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
            const existing = partialTools.get(event.toolCallId);
            if (existing) existing.args += event.delta;
            break;
          }

          case "tool-call":
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

      // Synthesise a GenerateResult for the llm-call-end event
      const syntheticResult: GenerateResult = {
        text: turnText,
        toolCalls: turnToolCalls,
        finishReason: turnToolCalls.length > 0 ? "tool_calls" : "stop",
      };
      dispatch(
        {
          type: "llm-call-end",
          agentName: agent.name,
          turn: turns,
          result: syntheticResult,
          durationMs: Date.now() - llmStart,
          timestamp: new Date().toISOString(),
        },
        onEvent,
        emitter,
      );
    } else {
      // Fallback: provider only has generate()
      const result = await agent.model.generate({
        messages,
        tools: agent.tools.length > 0 ? agent.tools : undefined,
        temperature,
        maxTokens,
        signal,
      });

      if (result.text) {
        turnText = result.text;
        yield { type: "text-delta", delta: result.text };
      }
      for (const tc of result.toolCalls) turnToolCalls.push(tc);
      yield {
        type: "turn-finish",
        turn: turns,
        finishReason: result.finishReason,
      };

      dispatch(
        {
          type: "llm-call-end",
          agentName: agent.name,
          turn: turns,
          result,
          durationMs: Date.now() - llmStart,
          timestamp: new Date().toISOString(),
        },
        onEvent,
        emitter,
      );
    }

    if (turnToolCalls.length === 0) {
      finalOutput = turnText;
      messages.push(assistantTextMessage(turnText));
      break;
    }

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

      const toolResult = await executeTool(
        tc,
        toolMap,
        turns,
        agent.name,
        onEvent,
        emitter,
        signal,
      );

      yield {
        type: "tool-call-end",
        turn: turns,
        toolName: tc.toolName,
        result: toolResult,
        durationMs: 0,
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

  dispatch(
    {
      type: "run-complete",
      agentName: agent.name,
      finalOutput,
      turns,
      totalDurationMs: Date.now() - runStart,
      timestamp: new Date().toISOString(),
    },
    onEvent,
    emitter,
  );

  // Save new messages back to thread
  if (thread) {
    thread.addMessages(messages.slice(messageCountBefore));
  }

  yield { type: "finish", finalOutput, messages, turns };
}
