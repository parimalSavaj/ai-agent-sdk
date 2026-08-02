/**
 * runner.ts
 *
 * run()       — executes an agent, returns a final result (non-streaming).
 * runStream() — executes an agent, yields StreamEvents as they arrive.
 *
 * Convention:
 *   - `RunOptions`, `RunResult`, `RunStreamEvent` use `type` — plain data.
 *   - `RunEvent` is a discriminated union of lifecycle variants.
 *
 * Phase 7: structured output — when `options.output` is provided the runner
 * appends a JSON schema instruction to the system prompt, validates the final
 * response against the Zod schema, and retries up to `maxOutputRetries` times
 * if the model returns invalid JSON or the wrong shape.
 */

import type { Agent } from "./agent.js";
import type { Message, ToolCallPart } from "./message.js";
import {
  systemMessage,
  userMessage,
  assistantTextMessage,
  assistantToolCallMessage,
  toolResultMessage,
} from "./message.js";
import type { GenerateResult, ToolCall } from "./provider.js";
import type { AgentEventEmitter } from "../events/emitter.js";
import type { Thread } from "./thread.js";
import type { OutputSchema } from "./output.js";
import { StructuredOutputError } from "./output.js";
import { z, type ZodTypeAny } from "zod";

// ── RunOptions ────────────────────────────────────────────────────────────────

export type RunOptions<TSchema extends ZodTypeAny = ZodTypeAny> = {
  maxTurns?: number;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onEvent?: (event: RunEvent) => void;
  thread?: Thread;
  emitter?: AgentEventEmitter;
  output?: OutputSchema<TSchema>;
  maxOutputRetries?: number;
};

// ── RunEvent ──────────────────────────────────────────────────────────────────

export type RunEvent =
  | {
      type: "llm-call-start";
      agentName: string;
      turn: number;
      messages: Message[];
      timestamp: string;
    }
  | {
      type: "llm-call-end";
      agentName: string;
      turn: number;
      result: GenerateResult;
      durationMs: number;
      timestamp: string;
    }
  | {
      type: "tool-call-start";
      agentName: string;
      turn: number;
      toolName: string;
      args: unknown;
      timestamp: string;
    }
  | {
      type: "tool-call-end";
      agentName: string;
      turn: number;
      toolName: string;
      result: unknown;
      durationMs: number;
      timestamp: string;
    }
  | {
      /** Fired when structured output passes validation */
      type: "output-valid";
      agentName: string;
      attempt: number;
      output: unknown;
      timestamp: string;
    }
  | {
      /** Fired when structured output fails validation — will retry */
      type: "output-invalid";
      agentName: string;
      attempt: number;
      rawOutput: string;
      /** Zod validation issues */
      issues: Array<{ path: string; message: string }>;
      timestamp: string;
    }
  | {
      type: "run-complete";
      agentName: string;
      finalOutput: string;
      turns: number;
      totalDurationMs: number;
      timestamp: string;
    };

// ── RunResult ─────────────────────────────────────────────────────────────────

export type RunResult<TOutput = unknown> = {
  finalOutput: string;
  messages: Message[];
  turns: number;
  /** Typed structured output — present when options.output validation succeeded */
  output?: TOutput;
};

// ── Internal helper ───────────────────────────────────────────────────────────

function dispatch(
  event: RunEvent,
  onEvent?: (e: RunEvent) => void,
  emitter?: AgentEventEmitter,
): void {
  onEvent?.(event);
  emitter?.emit(event);
}

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
export async function run<TSchema extends ZodTypeAny = ZodTypeAny>(
  agent: Agent,
  input: string,
  options: RunOptions<TSchema> = {},
): Promise<RunResult<z.infer<TSchema>>> {
  const {
    maxTurns = 10,
    temperature,
    maxTokens,
    signal,
    onEvent,
    emitter,
    thread,
    output: outputSchema,
    maxOutputRetries = 2,
  } = options;

  // When structured output is requested, append the JSON schema instruction
  // to the system prompt so the model knows what shape to produce.
  const systemContent = outputSchema
    ? agent.instructions + outputSchema.systemPromptSuffix
    : agent.instructions;

  const messages: Message[] = [
    systemMessage(systemContent),
    ...(thread ? thread.getMessages() : []),
    userMessage(input),
  ];

  const toolMap = new Map(agent.tools.map((t) => [t.name, t]));
  const messageCountBefore = messages.length;

  let turns = 0;
  let finalOutput = "";
  const runStart = Date.now();

  // ── Agent loop ────────────────────────────────────────────────────────────
  while (turns < maxTurns) {
    turns++;
    const llmStart = Date.now();

    dispatch(
      {
        type: "llm-call-start",
        agentName: agent.name,
        turn: turns,
        messages: [...messages],
        timestamp: new Date().toISOString(),
      },
      onEvent,
      emitter,
    );

    const result = await agent.model.generate({
      messages,
      tools: agent.tools.length > 0 ? agent.tools : undefined,
      temperature,
      maxTokens,
      signal,
    });

    dispatch(
      {
        type: "llm-call-end",
        agentName: agent.name,
        turn: turns,
        result,
        durationMs: Date.now() - llmStart,
        timestamp: new Date().toISOString(),
      },
      onEvent,
      emitter,
    );

    // No tool calls → final answer
    if (result.toolCalls.length === 0) {
      finalOutput = result.text;
      messages.push(assistantTextMessage(result.text));
      break;
    }

    // Tool calls → append assistant turn, execute, loop
    messages.push(
      assistantToolCallMessage(
        result.toolCalls.map(
          (tc): ToolCallPart => ({
            type: "tool-call",
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            args: tc.args,
          }),
        ),
        result.text,
      ),
    );

    for (const tc of result.toolCalls) {
      const toolResult = await executeTool(
        tc,
        toolMap,
        turns,
        agent.name,
        onEvent,
        emitter,
        signal,
      );
      messages.push(
        toolResultMessage(
          tc.toolCallId,
          tc.toolName,
          JSON.stringify(toolResult),
        ),
      );
    }

    if (turns >= maxTurns) {
      finalOutput = result.text;
      break;
    }
  }

  // ── Structured output validation + retry loop ─────────────────────────────
  let parsedOutput: z.infer<TSchema> | undefined;

  if (outputSchema) {
    let attempt = 0;
    let lastError: z.ZodError | undefined;
    let lastRaw = finalOutput;

    while (attempt <= maxOutputRetries) {
      attempt++;

      const parsed = outputSchema.safeParse(lastRaw);

      if (parsed.success) {
        parsedOutput = parsed.data as z.infer<TSchema>;
        dispatch(
          {
            type: "output-valid",
            agentName: agent.name,
            attempt,
            output: parsedOutput,
            timestamp: new Date().toISOString(),
          },
          onEvent,
          emitter,
        );
        break;
      }

      // Validation failed
      lastError = parsed.error;
      const issues = (parsed.error?.issues ?? []).map((i) => ({
        path: i.path.join(".") || "(root)",
        message: i.message,
      }));

      dispatch(
        {
          type: "output-invalid",
          agentName: agent.name,
          attempt,
          rawOutput: lastRaw,
          issues,
          timestamp: new Date().toISOString(),
        },
        onEvent,
        emitter,
      );

      if (attempt > maxOutputRetries) break;

      // Ask the model to fix its response
      const errorSummary = issues
        .map((i) => `  - ${i.path}: ${i.message}`)
        .join("\n");

      messages.push(
        userMessage(
          `Your response was not valid JSON matching the required schema.\n` +
            `Validation errors:\n${errorSummary}\n\n` +
            `Please respond again with a corrected JSON object only.`,
        ),
      );

      const llmStart = Date.now();
      dispatch(
        {
          type: "llm-call-start",
          agentName: agent.name,
          turn: turns + attempt,
          messages: [...messages],
          timestamp: new Date().toISOString(),
        },
        onEvent,
        emitter,
      );

      const retryResult = await agent.model.generate({
        messages,
        temperature,
        maxTokens,
        signal,
      });

      dispatch(
        {
          type: "llm-call-end",
          agentName: agent.name,
          turn: turns + attempt,
          result: retryResult,
          durationMs: Date.now() - llmStart,
          timestamp: new Date().toISOString(),
        },
        onEvent,
        emitter,
      );

      lastRaw = retryResult.text;
      finalOutput = retryResult.text;
      messages.push(assistantTextMessage(retryResult.text));
    }

    // All retries exhausted without valid output
    if (parsedOutput === undefined && lastError) {
      throw new StructuredOutputError(lastRaw, lastError, attempt);
    }
  }

  dispatch(
    {
      type: "run-complete",
      agentName: agent.name,
      finalOutput,
      turns,
      totalDurationMs: Date.now() - runStart,
      timestamp: new Date().toISOString(),
    },
    onEvent,
    emitter,
  );

  if (thread) {
    thread.addMessages(messages.slice(messageCountBefore));
  }

  return { finalOutput, messages, turns, output: parsedOutput };
}

// ── executeTool() ─────────────────────────────────────────────────────────────

async function executeTool(
  tc: ToolCall,
  toolMap: Map<
    string,
    {
      name: string;
      parameters: { parse: (v: unknown) => unknown };
      execute: (args: unknown) => Promise<unknown>;
    }
  >,
  turn: number,
  agentName: string,
  onEvent: RunOptions["onEvent"],
  emitter: RunOptions["emitter"],
  signal?: AbortSignal,
): Promise<unknown> {
  const tool = toolMap.get(tc.toolName);

  if (!tool) {
    const error = {
      error: `Unknown tool "${tc.toolName}". Available tools: ${[...toolMap.keys()].join(", ")}`,
    };
    dispatch(
      {
        type: "tool-call-start",
        agentName,
        turn,
        toolName: tc.toolName,
        args: tc.args,
        timestamp: new Date().toISOString(),
      },
      onEvent,
      emitter,
    );
    dispatch(
      {
        type: "tool-call-end",
        agentName,
        turn,
        toolName: tc.toolName,
        result: error,
        durationMs: 0,
        timestamp: new Date().toISOString(),
      },
      onEvent,
      emitter,
    );
    return error;
  }

  let parsedArgs: unknown;
  try {
    parsedArgs = tool.parameters.parse(JSON.parse(tc.args));
  } catch (err) {
    const error = {
      error: `Invalid arguments for tool "${tc.toolName}": ${err instanceof Error ? err.message : String(err)}`,
    };
    dispatch(
      {
        type: "tool-call-start",
        agentName,
        turn,
        toolName: tc.toolName,
        args: tc.args,
        timestamp: new Date().toISOString(),
      },
      onEvent,
      emitter,
    );
    dispatch(
      {
        type: "tool-call-end",
        agentName,
        turn,
        toolName: tc.toolName,
        result: error,
        durationMs: 0,
        timestamp: new Date().toISOString(),
      },
      onEvent,
      emitter,
    );
    return error;
  }

  dispatch(
    {
      type: "tool-call-start",
      agentName,
      turn,
      toolName: tc.toolName,
      args: parsedArgs,
      timestamp: new Date().toISOString(),
    },
    onEvent,
    emitter,
  );

  if (signal?.aborted) throw new Error("Run aborted before tool execution.");

  const start = Date.now();
  const result = await tool.execute(parsedArgs);
  const durationMs = Date.now() - start;

  dispatch(
    {
      type: "tool-call-end",
      agentName,
      turn,
      toolName: tc.toolName,
      result,
      durationMs,
      timestamp: new Date().toISOString(),
    },
    onEvent,
    emitter,
  );

  return result;
}

// ── RunStreamEvent ────────────────────────────────────────────────────────────

export type RunStreamEvent =
  | { type: "text-delta"; delta: string }
  | { type: "tool-call-start"; turn: number; toolName: string; args: unknown }
  | {
      type: "tool-call-end";
      turn: number;
      toolName: string;
      result: unknown;
      durationMs: number;
    }
  | { type: "turn-finish"; turn: number; finishReason: string }
  | { type: "finish"; finalOutput: string; messages: Message[]; turns: number };

// ── runStream() ───────────────────────────────────────────────────────────────

/**
 * Streaming version of run(). Returns an AsyncGenerator that yields
 * RunStreamEvents as they arrive from the model.
 *
 * @example
 * ```ts
 * for await (const event of runStream(agent, "Tell me a joke")) {
 *   if (event.type === "text-delta") process.stdout.write(event.delta);
 *   if (event.type === "finish") console.log("\nDone:", event.finalOutput);
 * }
 * ```
 */
export async function* runStream(
  agent: Agent,
  input: string,
  options: RunOptions = {},
): AsyncGenerator<RunStreamEvent> {
  const {
    maxTurns = 10,
    temperature,
    maxTokens,
    signal,
    onEvent,
    emitter,
    thread,
  } = options;

  const messages: Message[] = [
    systemMessage(agent.instructions),
    ...(thread ? thread.getMessages() : []),
    userMessage(input),
  ];

  const toolMap = new Map(agent.tools.map((t) => [t.name, t]));
  const messageCountBefore = messages.length;

  let turns = 0;
  let finalOutput = "";
  const runStart = Date.now();

  while (turns < maxTurns) {
    turns++;
    const llmStart = Date.now();

    dispatch(
      {
        type: "llm-call-start",
        agentName: agent.name,
        turn: turns,
        messages: [...messages],
        timestamp: new Date().toISOString(),
      },
      onEvent,
      emitter,
    );

    let turnText = "";
    const turnToolCalls: ToolCall[] = [];

    if (agent.model.stream) {
      const streamInput = {
        messages,
        tools: agent.tools.length > 0 ? agent.tools : undefined,
        temperature,
        maxTokens,
        signal,
      };

      const partialTools = new Map<
        string,
        { toolName: string; args: string }
      >();

      for await (const event of agent.model.stream(streamInput)) {
        switch (event.type) {
          case "text-delta":
            turnText += event.delta;
            yield { type: "text-delta", delta: event.delta };
            break;
          case "tool-call-delta": {
            const existing = partialTools.get(event.toolCallId);
            if (existing) existing.args += event.delta;
            break;
          }
          case "tool-call":
            partialTools.set(event.toolCallId, {
              toolName: event.toolName,
              args: event.args,
            });
            turnToolCalls.push({
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: event.args,
            });
            break;
          case "finish":
            yield {
              type: "turn-finish",
              turn: turns,
              finishReason: event.finishReason,
            };
            break;
        }
      }

      const syntheticResult: GenerateResult = {
        text: turnText,
        toolCalls: turnToolCalls,
        finishReason: turnToolCalls.length > 0 ? "tool_calls" : "stop",
      };
      dispatch(
        {
          type: "llm-call-end",
          agentName: agent.name,
          turn: turns,
          result: syntheticResult,
          durationMs: Date.now() - llmStart,
          timestamp: new Date().toISOString(),
        },
        onEvent,
        emitter,
      );
    } else {
      const result = await agent.model.generate({
        messages,
        tools: agent.tools.length > 0 ? agent.tools : undefined,
        temperature,
        maxTokens,
        signal,
      });
      if (result.text) {
        turnText = result.text;
        yield { type: "text-delta", delta: result.text };
      }
      for (const tc of result.toolCalls) turnToolCalls.push(tc);
      yield {
        type: "turn-finish",
        turn: turns,
        finishReason: result.finishReason,
      };
      dispatch(
        {
          type: "llm-call-end",
          agentName: agent.name,
          turn: turns,
          result,
          durationMs: Date.now() - llmStart,
          timestamp: new Date().toISOString(),
        },
        onEvent,
        emitter,
      );
    }

    if (turnToolCalls.length === 0) {
      finalOutput = turnText;
      messages.push(assistantTextMessage(turnText));
      break;
    }

    messages.push(
      assistantToolCallMessage(
        turnToolCalls.map(
          (tc): ToolCallPart => ({
            type: "tool-call",
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            args: tc.args,
          }),
        ),
        turnText,
      ),
    );

    for (const tc of turnToolCalls) {
      let parsedArgs: unknown = tc.args;
      try {
        parsedArgs = JSON.parse(tc.args);
      } catch {
        /* keep raw */
      }

      yield {
        type: "tool-call-start",
        turn: turns,
        toolName: tc.toolName,
        args: parsedArgs,
      };

      const toolResult = await executeTool(
        tc,
        toolMap,
        turns,
        agent.name,
        onEvent,
        emitter,
        signal,
      );

      yield {
        type: "tool-call-end",
        turn: turns,
        toolName: tc.toolName,
        result: toolResult,
        durationMs: 0,
      };

      messages.push(
        toolResultMessage(
          tc.toolCallId,
          tc.toolName,
          JSON.stringify(toolResult),
        ),
      );
    }

    if (turns >= maxTurns) {
      finalOutput = turnText;
      break;
    }
  }

  dispatch(
    {
      type: "run-complete",
      agentName: agent.name,
      finalOutput,
      turns,
      totalDurationMs: Date.now() - runStart,
      timestamp: new Date().toISOString(),
    },
    onEvent,
    emitter,
  );

  if (thread) {
    thread.addMessages(messages.slice(messageCountBefore));
  }

  yield { type: "finish", finalOutput, messages, turns };
}
