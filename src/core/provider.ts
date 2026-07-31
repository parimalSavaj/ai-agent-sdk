/**
 * provider.ts
 *
 * The ModelProvider interface and all related data types.
 *
 * Convention:
 *   - `ModelProvider` uses `interface` — it is a contract that adapter
 *     classes implement.
 *   - Everything else (input/output shapes, event variants, options) uses
 *     `type` — they are plain data with no behavior.
 */

import type { Message } from "./message.js";
import type { Tool } from "./tool.js";

// ── Token usage ───────────────────────────────────────────────────────────────

export type Usage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

// ── Tool call (parsed from a model response) ──────────────────────────────────

export type ToolCall = {
  toolCallId: string;
  toolName: string;
  /** Raw JSON string — the runner parses + validates against the Tool schema */
  args: string;
};

// ── Streaming event union ─────────────────────────────────────────────────────

export type TextDeltaEvent = {
  type: "text-delta";
  delta: string;
};

export type ToolCallDeltaEvent = {
  type: "tool-call-delta";
  toolCallId: string;
  delta: string;
};

export type ToolCallEvent = {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  /** Raw JSON string of the arguments */
  args: string;
};

export type FinishEvent = {
  type: "finish";
  finishReason: "stop" | "tool_calls" | "length" | "error" | string;
  usage?: Usage;
};

export type StreamEvent =
  | TextDeltaEvent
  | ToolCallDeltaEvent
  | ToolCallEvent
  | FinishEvent;

// ── generate() input / output ─────────────────────────────────────────────────

export type GenerateInput = {
  messages: Message[];
  tools?: Tool[];
  /** 0–2 range; undefined means use the model/provider default */
  temperature?: number;
  /** Hard cap on generated tokens */
  maxTokens?: number;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
};

export type GenerateResult = {
  /** The plain text of the final assistant turn (empty string when tool calls
   *  were made instead of/in addition to text) */
  text: string;
  /** Any tool calls the model requested in this turn */
  toolCalls: ToolCall[];
  finishReason: "stop" | "tool_calls" | "length" | "error" | string;
  usage?: Usage;
};

// ── Per-call model options ────────────────────────────────────────────────────

export type ModelOptions = {
  /** Override the base URL — used for local/self-hosted providers */
  baseURL?: string;
  /** API key override (falls back to env vars inside each adapter) */
  apiKey?: string;
  /** Any provider-specific options that don't have a first-class field */
  [key: string]: unknown;
};

// ── Provider factory type (used in the registry) ──────────────────────────────

export type ProviderFactory = (
  modelId: string,
  options?: ModelOptions,
) => ModelProvider;

// ── The ModelProvider interface ───────────────────────────────────────────────
// `interface` because this is a contract — adapter classes implement it.
// The runner only ever depends on this contract; it never imports a vendor SDK.

export interface ModelProvider {
  /** e.g. "openai", "anthropic", "ollama" */
  readonly providerId: string;
  /** e.g. "gpt-4o-mini", "claude-sonnet-4-5" */
  readonly modelId: string;

  /**
   * Single-shot generation. Returns a fully resolved result including text
   * output and/or tool call requests.
   */
  generate(input: GenerateInput): Promise<GenerateResult>;

  /**
   * Streaming generation. Yields normalized StreamEvents so the runner can
   * handle streaming the same way regardless of provider.
   * Phase 4 will require all providers to implement this.
   */
  stream?(input: GenerateInput): AsyncIterable<StreamEvent>;
}
