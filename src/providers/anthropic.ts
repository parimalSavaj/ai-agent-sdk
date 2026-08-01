/**
 * providers/anthropic.ts
 *
 * Native Anthropic adapter using the official @anthropic-ai/sdk.
 *
 * Anthropic's API differs from OpenAI in three important ways that we handle
 * entirely inside this file — nothing leaks out:
 *
 *  1. System prompt is a top-level field, not a message in the array.
 *  2. Assistant content is an array of typed blocks (TextBlock, ToolUseBlock)
 *     not a single string + tool_calls array.
 *  3. Tool results go back as user-role messages with a ToolResultBlockParam,
 *     not as a separate "tool" role message.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  ContentBlockParam,
  ToolResultBlockParam,
  ToolUseBlockParam,
  TextBlockParam,
} from "@anthropic-ai/sdk/resources/messages/messages.js";

import type {
  ModelProvider,
  ModelOptions,
  GenerateInput,
  GenerateResult,
  StreamEvent,
  ToolCall,
  Usage,
} from "../core/provider.js";
import type { Message } from "../core/message.js";
import type { Tool } from "../core/tool.js";

// ── Message mapping (SDK → Anthropic) ────────────────────────────────────────

/**
 * Extracts the system message string (if any) from the message list.
 * Anthropic requires it as a separate top-level field.
 */
function extractSystem(messages: Message[]): string | undefined {
  const sys = messages.find((m) => m.role === "system");
  return sys?.role === "system" ? sys.content : undefined;
}

/**
 * Converts SDK messages to Anthropic MessageParam array.
 * System messages are excluded — they're passed separately.
 * Tool result messages are merged into the preceding user turn as content blocks.
 */
function toAnthropicMessages(messages: Message[]): MessageParam[] {
  const result: MessageParam[] = [];

  for (const msg of messages) {
    switch (msg.role) {
      case "system":
        // Handled separately as top-level field
        break;

      case "user":
        result.push({ role: "user", content: msg.content });
        break;

      case "assistant": {
        // Build an array of content blocks from our parts
        const content: ContentBlockParam[] = [];
        for (const part of msg.content) {
          if (part.type === "text") {
            const block: TextBlockParam = { type: "text", text: part.text };
            content.push(block);
          } else if (part.type === "tool-call") {
            // Parse the args JSON string back to an object for Anthropic
            let input: Record<string, unknown> = {};
            try {
              input = JSON.parse(part.args);
            } catch {
              input = {};
            }
            const block: ToolUseBlockParam = {
              type: "tool_use",
              id: part.toolCallId,
              name: part.toolName,
              input,
            };
            content.push(block);
          }
        }
        result.push({ role: "assistant", content });
        break;
      }

      case "tool": {
        // Anthropic expects tool results as user-role messages with
        // tool_result content blocks. If the last message is already a user
        // message with tool_result blocks, append to it; otherwise create one.
        const toolResult: ToolResultBlockParam = {
          type: "tool_result",
          tool_use_id: msg.toolCallId,
          content: msg.content,
        };

        const last = result[result.length - 1];
        if (
          last &&
          last.role === "user" &&
          Array.isArray(last.content) &&
          (last.content as ContentBlockParam[]).every(
            (b) => (b as ContentBlockParam).type === "tool_result",
          )
        ) {
          (last.content as ToolResultBlockParam[]).push(toolResult);
        } else {
          result.push({ role: "user", content: [toolResult] });
        }
        break;
      }
    }
  }

  return result;
}

// ── Tool mapping (SDK Tool → Anthropic tool definition) ──────────────────────

function toAnthropicTools(tools: Tool[]): Anthropic.Messages.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.jsonSchema as Anthropic.Messages.Tool["input_schema"],
  }));
}

// ── Response mapping (Anthropic → SDK) ───────────────────────────────────────

function mapStopReason(
  reason: string | null | undefined,
): GenerateResult["finishReason"] {
  switch (reason) {
    case "end_turn":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    default:
      return reason ?? "stop";
  }
}

function mapUsage(
  usage: Anthropic.Messages.Usage | undefined,
): Usage | undefined {
  if (!usage) return undefined;
  return {
    promptTokens: usage.input_tokens,
    completionTokens: usage.output_tokens,
    totalTokens: usage.input_tokens + usage.output_tokens,
  };
}

// ── Adapter factory ───────────────────────────────────────────────────────────

export function createAnthropicProvider(
  modelId: string,
  options?: ModelOptions,
): ModelProvider {
  const client = new Anthropic({
    apiKey:
      (options?.apiKey as string | undefined) ?? process.env.ANTHROPIC_API_KEY,
    baseURL: options?.baseURL as string | undefined,
  });

  return {
    providerId: "anthropic",
    modelId,

    // ── generate() ──────────────────────────────────────────────────────────
    async generate(input: GenerateInput): Promise<GenerateResult> {
      const system = extractSystem(input.messages);
      const messages = toAnthropicMessages(input.messages);

      const response = await client.messages.create({
        model: modelId,
        max_tokens: input.maxTokens ?? 4096,
        messages,
        ...(system ? { system } : {}),
        ...(input.tools && input.tools.length > 0
          ? {
              tools: toAnthropicTools(input.tools),
              tool_choice: { type: "auto" },
            }
          : {}),
        ...(input.temperature !== undefined
          ? { temperature: input.temperature }
          : {}),
      });

      // Extract text from TextBlocks
      const text = response.content
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

      // Extract tool calls from ToolUseBlocks
      const toolCalls: ToolCall[] = response.content
        .filter(
          (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
        )
        .map((b) => ({
          toolCallId: b.id,
          toolName: b.name,
          args: JSON.stringify(b.input),
        }));

      return {
        text,
        toolCalls,
        finishReason: mapStopReason(response.stop_reason),
        usage: mapUsage(response.usage),
      };
    },

    // ── stream() ─────────────────────────────────────────────────────────────
    async *stream(input: GenerateInput): AsyncIterable<StreamEvent> {
      const system = extractSystem(input.messages);
      const messages = toAnthropicMessages(input.messages);

      const stream = client.messages.stream({
        model: modelId,
        max_tokens: input.maxTokens ?? 4096,
        messages,
        ...(system ? { system } : {}),
        ...(input.tools && input.tools.length > 0
          ? {
              tools: toAnthropicTools(input.tools),
              tool_choice: { type: "auto" },
            }
          : {}),
        ...(input.temperature !== undefined
          ? { temperature: input.temperature }
          : {}),
      });

      // Track tool-use blocks being streamed (keyed by content block index)
      const toolAccumulator = new Map<
        number,
        { id: string; name: string; args: string }
      >();

      for await (const event of stream) {
        switch (event.type) {
          case "content_block_start":
            if (event.content_block.type === "tool_use") {
              toolAccumulator.set(event.index, {
                id: event.content_block.id,
                name: event.content_block.name,
                args: "",
              });
            }
            break;

          case "content_block_delta":
            if (event.delta.type === "text_delta") {
              yield { type: "text-delta", delta: event.delta.text };
            } else if (event.delta.type === "input_json_delta") {
              const acc = toolAccumulator.get(event.index);
              if (acc) {
                acc.args += event.delta.partial_json;
                yield {
                  type: "tool-call-delta",
                  toolCallId: acc.id,
                  delta: event.delta.partial_json,
                };
              }
            }
            break;

          case "content_block_stop": {
            const acc = toolAccumulator.get(event.index);
            if (acc) {
              yield {
                type: "tool-call",
                toolCallId: acc.id,
                toolName: acc.name,
                args: acc.args,
              };
            }
            break;
          }

          case "message_delta":
            if (event.delta.stop_reason) {
              yield {
                type: "finish",
                finishReason: mapStopReason(event.delta.stop_reason),
                usage: event.usage
                  ? {
                      promptTokens: 0, // not available in delta
                      completionTokens: event.usage.output_tokens,
                      totalTokens: event.usage.output_tokens,
                    }
                  : undefined,
              };
            }
            break;
        }
      }
    },
  };
}
