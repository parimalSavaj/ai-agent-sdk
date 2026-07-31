/**
 * index.ts — public API surface of ai-agent-sdk
 *
 * Only the symbols explicitly exported here are part of the public contract.
 * Internal implementation details stay private.
 */

// ── Core functions ────────────────────────────────────────────────────────────
export { createAgent } from "./core/agent.js";
export { defineTool } from "./core/tool.js";
export { model, registerProvider } from "./core/model.js";
export { run } from "./core/runner.js";

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
export type { RunOptions, RunResult, RunEvent } from "./core/runner.js";

// ── Types — model() ───────────────────────────────────────────────────────────
export type { KnownProvider, ModelSpec } from "./core/model.js";
