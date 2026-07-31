/**
 * providers/openai.ts
 *
 * OpenAI adapter — maps the SDK's GenerateInput/Result types to/from the
 * OpenAI Chat Completions API using the official `openai` npm package.
 *
 * Nothing from this file leaks into the core; everything is hidden behind
 * the ModelProvider interface.
 */

import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionChunk,
} from "openai/resources/chat/completions.js";

import type {
  ModelProvider,
  ModelOptions,
  GenerateInput,
  GenerateResult,
  StreamEvent,
  ToolCall,
  Usage,
} from "../core/provider.js";
import type { Message, AssistantContentPart } from "../core/message.js";
import type { Tool } from "../core/tool.js";

// ── Message mapping (SDK → OpenAI) ────────────────────────────────────────────

function toOpenAIMessages(messages: Message[]): ChatCompletionMessageParam[] {
  return messages.map((msg): ChatCompletionMessageParam => {
    switch (msg.role) {
      case "system":
        return { role: "system", content: msg.content };

      case "user":
        return { role: "user", content: msg.content };

      case "assistant": {
        // Split content parts into text + tool_calls
        let text = "";
        const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];

        for (const part of msg.content) {
          if (part.type === "text") {
            text += part.text;
          } else if (part.type === "tool-call") {
            toolCalls.push({
              id: part.toolCallId,
              type: "function",
              function: {
                name: part.toolName,
                arguments: part.args,
              },
            });
          }
        }

        const result: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
          role: "assistant",
        };
        if (text) result.content = text;
        if (toolCalls.length > 0) result.tool_calls = toolCalls;
        return result;
      }

      case "tool":
        return {
          role: "tool",
          tool_call_id: msg.toolCallId,
          content: msg.content,
        };
    }
  });
}

// ── Tool mapping (SDK Tool → OpenAI tool definition) ─────────────────────────

function toOpenAITools(tools: Tool[]): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.jsonSchema as Record<string, unknown>,
    },
  }));
}

// ── Response mapping (OpenAI → SDK) ──────────────────────────────────────────

function mapFinishReason(
  reason: string | null | undefined,
): GenerateResult["finishReason"] {
  switch (reason) {
    case "stop":
      return "stop";
    case "tool_calls":
      return "tool_calls";
    case "length":
      return "length";
    default:
      return reason ?? "stop";
  }
}

function mapUsage(
  usage: OpenAI.CompletionUsage | undefined | null,
): Usage | undefined {
  if (!usage) return undefined;
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  };
}

// ── Adapter factory ───────────────────────────────────────────────────────────

export function createOpenAIProvider(
  modelId: string,
  options?: ModelOptions,
): ModelProvider {
  const client = new OpenAI({
    apiKey:
      (options?.apiKey as string | undefined) ?? process.env.OPENAI_API_KEY,
    baseURL: options?.baseURL as string | undefined,
  });

  return {
    providerId: "openai",
    modelId,

    // ── generate() ──────────────────────────────────────────────────────────
    async generate(input: GenerateInput): Promise<GenerateResult> {
      const response = await client.chat.completions.create(
        {
          model: modelId,
          messages: toOpenAIMessages(input.messages),
          ...(input.tools && input.tools.length > 0
            ? { tools: toOpenAITools(input.tools), tool_choice: "auto" }
            : {}),
          ...(input.temperature !== undefined
            ? { temperature: input.temperature }
            : {}),
          ...(input.maxTokens !== undefined
            ? { max_tokens: input.maxTokens }
            : {}),
        },
        { signal: input.signal },
      );

      const choice = response.choices[0];
      if (!choice) {
        throw new Error("OpenAI returned no choices.");
      }

      const assistantMsg = choice.message;
      const text = assistantMsg.content ?? "";

      const toolCalls: ToolCall[] = (assistantMsg.tool_calls ?? [])
        .filter((tc) => tc.type === "function")
        .map((tc) => ({
          toolCallId: tc.id,
          // tc.type === "function" is guaranteed by the filter above;
          // cast through unknown to satisfy the union narrowing TS requires.
          toolName: (
            tc as {
              type: "function";
              function: { name: string; arguments: string };
            }
          ).function.name,
          args: (
            tc as {
              type: "function";
              function: { name: string; arguments: string };
            }
          ).function.arguments,
        }));

      return {
        text,
        toolCalls,
        finishReason: mapFinishReason(choice.finish_reason),
        usage: mapUsage(response.usage),
      };
    },

    // ── stream() ─────────────────────────────────────────────────────────────
    // Phase 4 will flesh this out fully; we provide a basic implementation
    // here so the interface is satisfied and streaming works for text output.
    async *stream(input: GenerateInput): AsyncIterable<StreamEvent> {
      const stream = await client.chat.completions.create(
        {
          model: modelId,
          messages: toOpenAIMessages(input.messages),
          stream: true,
          ...(input.tools && input.tools.length > 0
            ? { tools: toOpenAITools(input.tools), tool_choice: "auto" }
            : {}),
          ...(input.temperature !== undefined
            ? { temperature: input.temperature }
            : {}),
          ...(input.maxTokens !== undefined
            ? { max_tokens: input.maxTokens }
            : {}),
        },
        { signal: input.signal },
      );

      // Accumulate tool-call argument deltas keyed by index
      const toolCallAccumulator = new Map<
        number,
        { toolCallId: string; toolName: string; args: string }
      >();

      let finishReason = "stop";

      for await (const chunk of stream as AsyncIterable<ChatCompletionChunk>) {
        const choice = chunk.choices[0];
        if (!choice) continue;

        const delta = choice.delta;

        // Text delta
        if (delta.content) {
          yield { type: "text-delta", delta: delta.content };
        }

        // Tool call deltas
        for (const tc of delta.tool_calls ?? []) {
          const idx = tc.index;
          if (!toolCallAccumulator.has(idx)) {
            toolCallAccumulator.set(idx, {
              toolCallId: tc.id ?? "",
              toolName: tc.function?.name ?? "",
              args: "",
            });
          }
          const acc = toolCallAccumulator.get(idx)!;
          if (tc.id) acc.toolCallId = tc.id;
          if (tc.function?.name) acc.toolName = tc.function.name;
          if (tc.function?.arguments) {
            acc.args += tc.function.arguments;
            yield {
              type: "tool-call-delta",
              toolCallId: acc.toolCallId,
              delta: tc.function.arguments,
            };
          }
        }

        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
      }

      // Emit fully assembled tool-call events
      for (const tc of toolCallAccumulator.values()) {
        yield {
          type: "tool-call",
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          args: tc.args,
        };
      }

      yield { type: "finish", finishReason };
    },
  };
}
