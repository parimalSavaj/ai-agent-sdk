/**
 * handoff.ts
 *
 * Handoffs — allow one agent to delegate a task to another agent.
 *
 * Design:
 *   A handoff is surfaced to the model as a regular tool. When the model calls
 *   it, the runner detects the HANDOFF_TOOL_PREFIX, swaps the active agent,
 *   and continues the loop with the new agent and the full conversation history
 *   transferred. This means:
 *
 *   - The model decides when to hand off (just like it decides when to call a tool)
 *   - Context always carries forward — the new agent sees the full history
 *   - A maxHandoffs counter prevents infinite delegation loops
 *   - Every handoff appears in RunEvent traces and RunResult.handoffs
 *
 * Convention:
 *   - `Handoff` uses `type` — plain data shape.
 *   - `HandoffError` is a class — thrown when the handoff loop limit is hit.
 *   - `defineHandoff()` is a factory function.
 */

import type { Agent } from "./agent.js";
import type { Tool } from "./tool.js";
import { Tool as ToolClass } from "./tool.js";
import { z } from "zod";

// ── Constants ─────────────────────────────────────────────────────────────────

/** All handoff tool names are prefixed with this string so the runner can
 *  distinguish them from regular tools without any extra metadata. */
export const HANDOFF_TOOL_PREFIX = "__handoff__";

// ── Handoff type ──────────────────────────────────────────────────────────────

export type Handoff = {
  /** The tool name the model will call to trigger this handoff */
  readonly toolName: string;
  /** Human-readable description — shown to the model */
  readonly description: string;
  /** The agent to transfer control to */
  readonly targetAgent: Agent;
  /**
   * Optional context to prepend to the first message sent to the target agent.
   * Useful for passing a structured summary of what was discussed so far.
   */
  readonly contextMessage?: string;
  /** The Tool object the runner registers alongside regular tools */
  readonly tool: Tool;
};

// ── HandoffError ──────────────────────────────────────────────────────────────

export class HandoffError extends Error {
  readonly fromAgent: string;
  readonly toAgent: string;
  readonly handoffCount: number;

  constructor(fromAgent: string, toAgent: string, handoffCount: number) {
    super(
      `Handoff loop limit reached after ${handoffCount} handoff(s). ` +
        `Last attempted: "${fromAgent}" → "${toAgent}". ` +
        `Increase maxHandoffs if deeper delegation is intended.`,
    );
    this.name = "HandoffError";
    this.fromAgent = fromAgent;
    this.toAgent = toAgent;
    this.handoffCount = handoffCount;
  }
}

// ── HandoffRecord — one entry in RunResult.handoffs ──────────────────────────

export type HandoffRecord = {
  /** Agent that initiated the handoff */
  fromAgent: string;
  /** Agent that received control */
  toAgent: string;
  /** The context/reason the model passed when calling the handoff tool */
  context: string;
  timestamp: string;
};

// ── defineHandoff() ───────────────────────────────────────────────────────────

/**
 * Define a handoff from one agent to another.
 *
 * The handoff is surfaced to the model as a tool. Add the returned `Handoff`
 * to the source agent's `handoffs` array — the runner registers its `.tool`
 * alongside the agent's regular tools automatically.
 *
 * @example
 * ```ts
 * const handoffToBilling = defineHandoff({
 *   name: "handoff_to_billing",
 *   description: "Transfer to the Billing Agent for payment questions.",
 *   targetAgent: billingAgent,
 * });
 *
 * const triageAgent = createAgent({
 *   name: "Triage Agent",
 *   instructions: "...",
 *   model: model("openai/gpt-4o-mini"),
 *   handoffs: [handoffToBilling],
 * });
 * ```
 */
export function defineHandoff(config: {
  name: string;
  description: string;
  targetAgent: Agent;
  contextMessage?: string;
}): Handoff {
  const toolName = `${HANDOFF_TOOL_PREFIX}${config.name}`;

  // The tool the model calls to trigger the handoff.
  // It accepts a single `context` string so the model can explain why it's
  // handing off — this is logged and passed to the target agent.
  const tool = new ToolClass({
    name: toolName,
    description:
      config.description +
      " Pass a brief summary of the conversation context and the user's intent.",
    parameters: z.object({
      context: z
        .string()
        .describe(
          "Brief summary of what the user needs and why you are handing off.",
        ),
    }),
    // execute is a no-op — the runner intercepts handoff tool calls before
    // executeTool() is ever called, so this never runs.
    execute: async () => ({ handoff: true }),
  });

  return {
    toolName,
    description: config.description,
    targetAgent: config.targetAgent,
    contextMessage: config.contextMessage,
    tool,
  };
}

// ── isHandoffToolCall ─────────────────────────────────────────────────────────

/** Returns true if a tool call name belongs to a handoff */
export function isHandoffToolCall(toolName: string): boolean {
  return toolName.startsWith(HANDOFF_TOOL_PREFIX);
}
