/**
 * message.ts
 *
 * The canonical message types that flow through the SDK.
 * Every provider adapter translates to/from these — the core never
 * deals with vendor-specific message shapes.
 *
 * Convention: all of these are plain data shapes, so they use `type`.
 */

// ── Individual content parts (used inside assistant messages) ─────────────────

export type TextPart = {
  type: "text";
  text: string;
};

export type ToolCallPart = {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  /** Raw JSON string of the arguments object */
  args: string;
};

export type AssistantContentPart = TextPart | ToolCallPart;

// ── Message variants ──────────────────────────────────────────────────────────

export type SystemMessage = {
  role: "system";
  content: string;
};

export type UserMessage = {
  role: "user";
  content: string;
};

export type AssistantMessage = {
  role: "assistant";
  /**
   * An assistant turn can contain plain text, tool-call requests, or both.
   * Using an array of parts (rather than a single string) lets one assistant
   * turn carry multiple tool calls alongside text — which OpenAI and Anthropic
   * both allow.
   */
  content: AssistantContentPart[];
};

export type ToolResultMessage = {
  role: "tool";
  toolCallId: string;
  toolName: string;
  /** Serialised result returned by the tool executor */
  content: string;
};

/** Discriminated union of all message types */
export type Message =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolResultMessage;

// ── Helpers ───────────────────────────────────────────────────────────────────

export function systemMessage(content: string): SystemMessage {
  return { role: "system", content };
}

export function userMessage(content: string): UserMessage {
  return { role: "user", content };
}

export function assistantTextMessage(text: string): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

/**
 * Build an AssistantMessage that carries one or more tool-call requests
 * (and optionally some leading text) exactly as the model returned them.
 * This is appended to history before executing tools so the model sees its
 * own prior requests when we re-call it with the tool results.
 */
export function assistantToolCallMessage(
  toolCalls: ToolCallPart[],
  text = "",
): AssistantMessage {
  const content: AssistantContentPart[] = [];
  if (text) content.push({ type: "text", text });
  content.push(...toolCalls);
  return { role: "assistant", content };
}

export function toolResultMessage(
  toolCallId: string,
  toolName: string,
  content: string,
): ToolResultMessage {
  return { role: "tool", toolCallId, toolName, content };
}
