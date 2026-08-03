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
import type {
  InputGuardrail,
  ToolGuardrail,
  OutputGuardrail,
} from "./guardrail.js";
import {
  checkInputGuardrails,
  checkToolGuardrails,
  checkOutputGuardrails,
} from "./guardrail.js";
import type { Handoff, HandoffRecord } from "./handoff.js";
import {
  HANDOFF_TOOL_PREFIX,
  isHandoffToolCall,
  HandoffError,
} from "./handoff.js";
import { generateWithReliability } from "./reliability.js";

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
  /**
   * Maximum number of agent-to-agent handoffs allowed in a single run.
   * Prevents infinite delegation loops. Default: 3
   */
  maxHandoffs?: number;
  /**
   * Maximum number of attempts per LLM call (1 = no retry). Default: 1
   * On failure, waits `retryDelay` ms before each retry (doubles each time).
   */
  maxRetries?: number;
  /**
   * Base delay in ms between retries. Doubles each attempt. Default: 1000
   */
  retryDelay?: number;
  /**
   * Per-call timeout in ms. If the model doesn't respond within this time,
   * the call is cancelled and retried (or fails). Default: no timeout
   */
  callTimeout?: number;
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
    }
  | {
      /** Fired whenever a guardrail blocks input, a tool call, or output */
      type: "guardrail-triggered";
      agentName: string;
      guardrailName: string;
      guardrailType: "input" | "tool" | "output";
      /** The value that was blocked (input string, tool args, or output string) */
      blockedValue: unknown;
      reason: string;
      timestamp: string;
    }
  | {
      /** Fired just before control transfers to a new agent */
      type: "handoff-start";
      fromAgent: string;
      toAgent: string;
      context: string;
      handoffCount: number;
      timestamp: string;
    }
  | {
      /** Fired after the target agent completes its work */
      type: "handoff-complete";
      fromAgent: string;
      toAgent: string;
      finalOutput: string;
      timestamp: string;
    }
  | {
      /** Fired before each retry attempt after a failed LLM call */
      type: "llm-call-retry";
      agentName: string;
      turn: number;
      attempt: number;
      error: string;
      delayMs: number;
      /** true if this retry will use the fallback model */
      usingFallback: boolean;
      timestamp: string;
    };

// ── RunResult ─────────────────────────────────────────────────────────────────

export type RunResult<TOutput = unknown> = {
  finalOutput: string;
  messages: Message[];
  turns: number;
  /** Typed structured output — present when options.output validation succeeded */
  output?: TOutput;
  /** All handoffs that occurred during this run, in order */
  handoffs: HandoffRecord[];
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
    maxHandoffs = 3,
    maxRetries = 1,
    retryDelay = 1000,
    callTimeout,
  } = options;

  // When structured output is requested, append the JSON schema instruction
  // to the system prompt so the model knows what shape to produce.
  const systemContent = outputSchema
    ? agent.instructions + outputSchema.systemPromptSuffix
    : agent.instructions;

  const userMsg = userMessage(input);
  const messages: Message[] = [
    systemMessage(systemContent),
    ...(thread ? thread.getMessages() : []),
    userMsg,
  ];

  // Build combined tool map: regular tools + handoff stub tools
  // Handoff tools are detected by HANDOFF_TOOL_PREFIX before executeTool() runs.
  const allTools = [...agent.tools, ...agent.handoffs.map((h) => h.tool)];
  const toolMap = new Map(allTools.map((t) => [t.name, t]));
  // messageCountBefore is set BEFORE user message so the user message is also
  // persisted to the thread at the end of the run.
  const messageCountBefore = messages.length - 1;

  // Handoff tracking
  const handoffRecords: HandoffRecord[] = [];
  let handoffCount = 0;
  const visitedAgents = new Set<string>([agent.name]);

  // active agent — may change during handoffs
  let activeAgent = agent;

  let turns = 0;
  let finalOutput = "";
  const runStart = Date.now();

  // ── Input guardrails ──────────────────────────────────────────────────────
  // Run before the first LLM call. GuardrailError thrown here propagates
  // directly to the caller — the LLM is never contacted.
  if (agent.inputGuardrails.length > 0) {
    try {
      await checkInputGuardrails(agent.inputGuardrails, input);
    } catch (err) {
      if (err instanceof Error && err.name === "GuardrailError") {
        const ge = err as import("./guardrail.js").GuardrailError;
        dispatch(
          {
            type: "guardrail-triggered",
            agentName: agent.name,
            guardrailName: ge.guardrailName,
            guardrailType: "input",
            blockedValue: input,
            reason: ge.reason,
            timestamp: new Date().toISOString(),
          },
          onEvent,
          emitter,
        );
      }
      throw err;
    }
  }

  // ── Agent loop ────────────────────────────────────────────────────────────
  while (turns < maxTurns) {
    turns++;
    const llmStart = Date.now();

    // Rebuild tool map when activeAgent changes (after a handoff)
    const activeAllTools = [
      ...activeAgent.tools,
      ...activeAgent.handoffs.map((h) => h.tool),
    ];
    const activeToolMap = new Map(activeAllTools.map((t) => [t.name, t]));

    dispatch(
      {
        type: "llm-call-start",
        agentName: activeAgent.name,
        turn: turns,
        messages: [...messages],
        timestamp: new Date().toISOString(),
      },
      onEvent,
      emitter,
    );

    const generateInput = {
      messages,
      tools: activeAllTools.length > 0 ? activeAllTools : undefined,
      temperature,
      maxTokens,
      signal,
    };

    const { result, usedFallback } = await generateWithReliability(
      activeAgent.model,
      generateInput,
      {
        maxAttempts: maxRetries,
        retryDelay,
        callTimeout,
        fallbackProvider: activeAgent.fallbackModel,
        onRetry: (attempt, error) => {
          const isLastAttempt = attempt >= maxRetries;
          dispatch(
            {
              type: "llm-call-retry",
              agentName: activeAgent.name,
              turn: turns,
              attempt,
              error: error.message,
              delayMs: Math.min(retryDelay * Math.pow(2, attempt - 1), 30_000),
              usingFallback: isLastAttempt && !!activeAgent.fallbackModel,
              timestamp: new Date().toISOString(),
            },
            onEvent,
            emitter,
          );
        },
      },
    );

    dispatch(
      {
        type: "llm-call-end",
        agentName: activeAgent.name,
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

    // Tool calls → separate handoffs from regular tool calls
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

    let didHandoff = false;

    for (const tc of result.toolCalls) {
      // ── Handoff detection ────────────────────────────────────────────────
      if (isHandoffToolCall(tc.toolName)) {
        // Find the handoff definition on the active agent
        const handoff = activeAgent.handoffs.find(
          (h) => h.toolName === tc.toolName,
        );

        if (!handoff) {
          // Shouldn't happen, but handle gracefully
          messages.push(
            toolResultMessage(
              tc.toolCallId,
              tc.toolName,
              JSON.stringify({
                error: `Handoff tool "${tc.toolName}" not found on agent "${activeAgent.name}"`,
              }),
            ),
          );
          continue;
        }

        // Parse the context arg the model passed
        let context = "";
        try {
          const args = JSON.parse(tc.args) as { context?: string };
          context = args.context ?? "";
        } catch {
          context = tc.args;
        }

        // ── Loop prevention ──────────────────────────────────────────────
        handoffCount++;
        if (handoffCount > maxHandoffs) {
          throw new HandoffError(
            activeAgent.name,
            handoff.targetAgent.name,
            handoffCount,
          );
        }

        dispatch(
          {
            type: "handoff-start",
            fromAgent: activeAgent.name,
            toAgent: handoff.targetAgent.name,
            context,
            handoffCount,
            timestamp: new Date().toISOString(),
          },
          onEvent,
          emitter,
        );

        // Acknowledge the handoff tool call so the message history is valid
        messages.push(
          toolResultMessage(
            tc.toolCallId,
            tc.toolName,
            JSON.stringify({
              handoff: "initiated",
              to: handoff.targetAgent.name,
            }),
          ),
        );

        // Record the handoff
        const record: HandoffRecord = {
          fromAgent: activeAgent.name,
          toAgent: handoff.targetAgent.name,
          context,
          timestamp: new Date().toISOString(),
        };
        handoffRecords.push(record);

        // Switch active agent — the loop continues with the new agent
        // The full message history carries forward (context preserved)
        activeAgent = handoff.targetAgent;
        visitedAgents.add(activeAgent.name);

        dispatch(
          {
            type: "handoff-complete",
            fromAgent: record.fromAgent,
            toAgent: record.toAgent,
            finalOutput: "",
            timestamp: new Date().toISOString(),
          },
          onEvent,
          emitter,
        );

        didHandoff = true;
        // Only one handoff per turn — skip remaining tool calls in this batch
        break;
      }

      // ── Regular tool call ────────────────────────────────────────────────
      const toolResult = await executeTool(
        tc,
        activeToolMap,
        turns,
        activeAgent.name,
        onEvent,
        emitter,
        signal,
        activeAgent.toolGuardrails,
      );
      messages.push(
        toolResultMessage(
          tc.toolCallId,
          tc.toolName,
          JSON.stringify(toolResult),
        ),
      );
    }

    // After a handoff we continue the loop — the new agent will respond
    // to the accumulated messages on the next iteration.
    if (!didHandoff && turns >= maxTurns) {
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

  // ── Output guardrails ─────────────────────────────────────────────────────
  if (activeAgent.outputGuardrails.length > 0) {
    try {
      await checkOutputGuardrails(activeAgent.outputGuardrails, finalOutput);
    } catch (err) {
      if (err instanceof Error && err.name === "GuardrailError") {
        const ge = err as import("./guardrail.js").GuardrailError;
        dispatch(
          {
            type: "guardrail-triggered",
            agentName: activeAgent.name,
            guardrailName: ge.guardrailName,
            guardrailType: "output",
            blockedValue: finalOutput,
            reason: ge.reason,
            timestamp: new Date().toISOString(),
          },
          onEvent,
          emitter,
        );
      }
      throw err;
    }
  }

  dispatch(
    {
      type: "run-complete",
      agentName: activeAgent.name,
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

  return {
    finalOutput,
    messages,
    turns,
    output: parsedOutput,
    handoffs: handoffRecords,
  };
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
  toolGuardrails: ToolGuardrail[] = [],
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

  // ── Tool guardrails ────────────────────────────────────────────────────────
  // Check after arg parsing but before execution. On block, return a structured
  // error to the model — does not throw, lets the model self-correct.
  const guardrailErr = await checkToolGuardrails(
    toolGuardrails,
    tc.toolName,
    parsedArgs,
  );
  if (guardrailErr) {
    dispatch(
      {
        type: "guardrail-triggered",
        agentName,
        guardrailName: guardrailErr.guardrailName,
        guardrailType: "tool",
        blockedValue: parsedArgs,
        reason: guardrailErr.reason,
        timestamp: new Date().toISOString(),
      },
      onEvent,
      emitter,
    );
    const blockedResult = {
      error: `Tool "${tc.toolName}" blocked by guardrail "${guardrailErr.guardrailName}": ${guardrailErr.reason}`,
    };
    dispatch(
      {
        type: "tool-call-end",
        agentName,
        turn,
        toolName: tc.toolName,
        result: blockedResult,
        durationMs: 0,
        timestamp: new Date().toISOString(),
      },
      onEvent,
      emitter,
    );
    return blockedResult;
  }

  if (signal?.aborted) throw new Error("Run aborted before tool execution.");

  const start = Date.now();
  let result: unknown;
  try {
    result = await tool.execute(parsedArgs);
  } catch (err) {
    const durationMs = Date.now() - start;
    const errorResult = {
      error: `Tool "${tc.toolName}" threw an error: ${err instanceof Error ? err.message : String(err)}`,
    };
    dispatch(
      {
        type: "tool-call-end",
        agentName,
        turn,
        toolName: tc.toolName,
        result: errorResult,
        durationMs,
        timestamp: new Date().toISOString(),
      },
      onEvent,
      emitter,
    );
    return errorResult;
  }
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
        agent.toolGuardrails,
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
