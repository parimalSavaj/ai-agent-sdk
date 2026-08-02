/**
 * agent.ts
 *
 * Agent config type and the Agent class.
 *
 * Convention:
 *   - `AgentConfig` uses `type` — plain input shape passed to createAgent().
 *   - `Agent` is a class — normalises config, fills defaults, exposes readonly
 *     fields. Stateless so one instance is safely reusable across concurrent runs.
 */

import type { ModelProvider } from "./provider.js";
import type { Tool } from "./tool.js";
import type {
  InputGuardrail,
  ToolGuardrail,
  OutputGuardrail,
} from "./guardrail.js";
import type { Handoff } from "./handoff.js";
// ── AgentConfig ───────────────────────────────────────────────────────────────

export type AgentConfig = {
  /** Human-readable name; used in logs and events */
  name: string;
  /**
   * System prompt — the agent's persona and standing instructions.
   * Prepended to every conversation as a system message.
   */
  instructions: string;
  /**
   * The model provider to use. Pass the result of model("openai/gpt-4o-mini")
   * or any object satisfying the ModelProvider interface.
   */
  model: ModelProvider;
  /** Tools available to this agent. Empty by default. */
  tools?: Tool[];
  /**
   * Fallback model provider — used when all retry attempts on the primary
   * model fail. One attempt is made on the fallback with no further retries.
   *
   * @example
   * ```ts
   * const agent = createAgent({
   *   model: model("openai/gpt-4o-mini"),
   *   fallbackModel: model("openrouter/anthropic/claude-3-haiku"),
   * });
   * ```
   */
  fallbackModel?: ModelProvider;
  /**
   * Handoffs this agent can perform — each one is surfaced to the model as
   * a tool. When the model calls it, the runner switches to the target agent
   * and continues the loop with the full conversation context transferred.
   */
  handoffs?: Handoff[];
  /**
   * Input guardrails — validated against the user's message before the first
   * LLM call. Throw GuardrailError to block the run entirely.
   */
  inputGuardrails?: InputGuardrail[];
  /**
   * Tool guardrails — validated against each tool's parsed args before it
   * executes. Blocked tools return a structured error to the model instead
   * of running, allowing the model to self-correct or give a final answer.
   */
  toolGuardrails?: ToolGuardrail[];
  /**
   * Output guardrails — validated against the final model response before
   * it is returned to the caller. Throw GuardrailError to block the result.
   */
  outputGuardrails?: OutputGuardrail[];
};

// ── Agent class ───────────────────────────────────────────────────────────────

export class Agent {
  readonly name: string;
  readonly instructions: string;
  readonly model: ModelProvider;
  readonly fallbackModel?: ModelProvider;
  readonly tools: Tool[];
  readonly handoffs: Handoff[];
  readonly inputGuardrails: InputGuardrail[];
  readonly toolGuardrails: ToolGuardrail[];
  readonly outputGuardrails: OutputGuardrail[];

  constructor(config: AgentConfig) {
    this.name = config.name;
    this.instructions = config.instructions;
    this.model = config.model;
    this.fallbackModel = config.fallbackModel;
    this.tools = config.tools ?? [];
    this.handoffs = config.handoffs ?? [];
    this.inputGuardrails = config.inputGuardrails ?? [];
    this.toolGuardrails = config.toolGuardrails ?? [];
    this.outputGuardrails = config.outputGuardrails ?? [];
  }
}

// ── createAgent() ─────────────────────────────────────────────────────────────

/**
 * Create a reusable agent definition from a config object.
 *
 * @example
 * ```ts
 * const agent = createAgent({
 *   name: "Support Agent",
 *   instructions: "You are a helpful assistant.",
 *   model: model("openai/gpt-4o-mini"),
 *   inputGuardrails: [noEmptyInput],
 *   toolGuardrails: [safeDelete],
 *   outputGuardrails: [noSecrets],
 * });
 * ```
 */
export function createAgent(config: AgentConfig): Agent {
  return new Agent(config);
}
