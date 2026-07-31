/**
 * agent.ts
 *
 * Agent config type and the Agent class.
 *
 * Convention:
 *   - `AgentConfig` uses `type` — it is the plain input shape you pass to
 *     createAgent().
 *   - `Agent` is a class — it has a constructor that normalises the config
 *     (fills defaults) and exposes the resolved properties as readonly fields.
 *     The same Agent instance is safely reusable across concurrent runs
 *     because it holds zero mutable state.
 */

import type { ModelProvider } from "./provider.js";
import type { Tool } from "./tool.js";

// ── AgentConfig — what the caller passes in ───────────────────────────────────

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
};

// ── Agent class ───────────────────────────────────────────────────────────────

export class Agent {
  readonly name: string;
  readonly instructions: string;
  readonly model: ModelProvider;
  readonly tools: Tool[];

  constructor(config: AgentConfig) {
    this.name = config.name;
    this.instructions = config.instructions;
    this.model = config.model;
    this.tools = config.tools ?? [];
  }
}

// ── createAgent() ─────────────────────────────────────────────────────────────
// Factory function — matches the public API in the plan and keeps call sites
// clean (no `new` keyword needed at the consumer level).

/**
 * Create a reusable agent definition from a config object.
 *
 * @example
 * ```ts
 * const agent = createAgent({
 *   name: "Support Agent",
 *   instructions: "You are a helpful assistant.",
 *   model: model("openai/gpt-4o-mini"),
 * });
 * ```
 */
export function createAgent(config: AgentConfig): Agent {
  return new Agent(config);
}
