/**
 * index.ts — public API surface of sugam
 *
 * Only the symbols explicitly exported here are part of the public contract.
 * Internal implementation details stay private.
 */

// ── Core functions ────────────────────────────────────────────────────────────
export { createAgent } from "./core/agent.js";
export { defineTool } from "./core/tool.js";
export { model, registerProvider } from "./core/model.js";
export { run, runStream } from "./core/runner.js";
export { AgentEventEmitter } from "./events/emitter.js";
export {
  createThread,
  getDefaultStore,
  InMemoryThreadStore,
} from "./core/thread.js";
export {
  defineOutput,
  OutputSchema,
  StructuredOutputError,
} from "./core/output.js";
export { defineGuardrail, GuardrailError } from "./core/guardrail.js";
export { defineHandoff, HandoffError } from "./core/handoff.js";
export {
  RetryError,
  TimeoutError,
  callWithRetry,
  callWithTimeout,
  generateWithReliability,
} from "./core/reliability.js";

// ── Types — agent ─────────────────────────────────────────────────────────────
export type { Agent, AgentConfig } from "./core/agent.js";

// ── Types — tools ─────────────────────────────────────────────────────────────
export type { Tool, ToolDefinition, JsonSchema } from "./core/tool.js";

// ── Types — messages ──────────────────────────────────────────────────────────
export type {
  Message,
  SystemMessage,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  TextPart,
  ToolCallPart,
  AssistantContentPart,
} from "./core/message.js";
export {
  systemMessage,
  userMessage,
  assistantTextMessage,
  assistantToolCallMessage,
  toolResultMessage,
} from "./core/message.js";

// ── Types — provider ──────────────────────────────────────────────────────────
export type {
  ModelProvider,
  ModelOptions,
  ProviderFactory,
  GenerateInput,
  GenerateResult,
  StreamEvent,
  TextDeltaEvent,
  ToolCallDeltaEvent,
  ToolCallEvent,
  FinishEvent,
  ToolCall,
  Usage,
} from "./core/provider.js";

// ── Types — runner ────────────────────────────────────────────────────────────
export type {
  RunOptions,
  RunResult,
  RunEvent,
  RunStreamEvent,
} from "./core/runner.js";

// ── Types — events ────────────────────────────────────────────────────────────
export type { EventMap } from "./events/emitter.js";

// ── Types — model() ───────────────────────────────────────────────────────────
export type { KnownProvider, ModelSpec } from "./core/model.js";

// ── Types — thread ────────────────────────────────────────────────────────────
export type { ThreadStore } from "./core/thread.js";
export { Thread } from "./core/thread.js";

// ── Types — guardrails ────────────────────────────────────────────────────────
export type {
  Guardrail,
  GuardrailType,
  GuardrailResult,
  InputGuardrail,
  ToolGuardrail,
  OutputGuardrail,
} from "./core/guardrail.js";

// ── Types — handoffs ──────────────────────────────────────────────────────────
export type { Handoff, HandoffRecord } from "./core/handoff.js";
