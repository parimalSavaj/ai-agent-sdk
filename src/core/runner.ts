/**
 * runner.ts
 *
 * run() — executes an agent against a user prompt and returns the final result.
 *
 * Convention:
 *   - `RunOptions` and `RunResult` use `type` — plain data shapes.
 *   - `RunEvent` uses `type` — it is a discriminated union of data variants.
 *
 * Phase 1: single-turn, no tool execution. The loop infrastructure is already
 * in place (maxTurns, turn counter) so Phase 2 (tool calling) is an additive
 * change, not a rewrite.
 */

import type { Agent } from "./agent.js";
import type { Message } from "./message.js";
import { systemMessage, userMessage, assistantTextMessage } from "./message.js";
import type { GenerateResult } from "./provider.js";

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
   * Lifecycle hook — called after every internal event.
   * Phase 5 will enrich the event types.
   */
  onEvent?: (event: RunEvent) => void;
};

// ── RunEvent — discriminated union of lifecycle events ────────────────────────

export type RunEvent =
  | { type: "llm-call-start"; turn: number; messages: Message[] }
  | { type: "llm-call-end"; turn: number; result: GenerateResult }
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

  let turns = 0;
  let finalOutput = "";

  while (turns < maxTurns) {
    turns++;

    onEvent?.({ type: "llm-call-start", turn: turns, messages: [...messages] });

    const result = await agent.model.generate({
      messages,
      tools: agent.tools.length > 0 ? agent.tools : undefined,
      temperature,
      maxTokens,
      signal,
    });

    onEvent?.({ type: "llm-call-end", turn: turns, result });

    // ── Phase 1: no tool calls yet ───────────────────────────────────────────
    // If the model returns a text response (finish reason "stop"), we're done.
    // Tool-calling execution is wired in Phase 2.

    if (result.finishReason === "stop" || result.toolCalls.length === 0) {
      finalOutput = result.text;
      messages.push(assistantTextMessage(result.text));
      break;
    }

    // Safety: if we somehow hit maxTurns without a stop, use what we have
    if (turns >= maxTurns) {
      finalOutput = result.text;
      messages.push(assistantTextMessage(result.text));
      break;
    }
  }

  onEvent?.({ type: "run-complete", finalOutput, turns });

  return { finalOutput, messages, turns };
}
