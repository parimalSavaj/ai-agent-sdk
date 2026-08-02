# AI Agent SDK — Implementation Plan

> Derived from `PROJECT.md` requirements. Tracks what is built, what is next,
> and the exact implementation plan for each remaining phase.

---

## Current Status

| #   | Feature            | Status  | Marks |
| --- | ------------------ | ------- | ----- |
| 1   | Agent Runtime      | ✅ Done | 15    |
| 2   | Tools              | ✅ Done | 10    |
| 3   | Memory & Sessions  | ✅ Done | 10    |
| 4   | Streaming & Events | ✅ Done | 10    |
| 5   | Model Providers    | ✅ Done | —     |
| 6   | Tracing            | ✅ Done | 5     |
| 7   | Structured Output  | ✅ Done | 10    |
| 8   | Guardrails         | ✅ Done | 10    |
| 9   | Handoffs           | ✅ Done | 10    |
| 10  | Reliability        | ✅ Done | 10    |
| 11  | SDK Name           | ✅ Done | —     |
| 12  | Documentation      | ✅ Done | 10    |

---

## What Is Already Built

### Agent Runtime ✅

- `createAgent(config)` — stateless agent definition
- `run(agent, input, options)` — full multi-turn loop
- `runStream(agent, input, options)` — streaming version
- Tool detection → execution → result injection → re-call loop
- `maxTurns` safety limit

### Tools ✅

- `defineTool({ name, description, parameters, execute })`
- Zod schema → JSON schema conversion (Zod v4 compatible)
- Runtime argument validation via `parameters.parse()`
- Async execution, typed results
- Unknown tool / bad args → structured error returned to model (self-corrects)

### Memory & Sessions ✅

- `Thread` class — holds message history, auto-generated id
- `ThreadStore` interface — swappable storage backend
- `InMemoryThreadStore` — default in-process implementation
- `createThread()` — factory, registers in default store
- System messages excluded from thread storage
- Multiple concurrent independent threads

### Streaming & Events ✅

- `runStream()` — `AsyncGenerator<RunStreamEvent>`
- `RunStreamEvent` union: `text-delta`, `tool-call-start`, `tool-call-end`, `turn-finish`, `finish`
- `AgentEventEmitter` class — typed `on/off/onAny/emit/clear`
- `RunEvent` union with `agentName`, `timestamp`, `durationMs` on every event
- `onEvent` inline callback + `emitter` subscription — both compose

### Model Providers ✅

- `ModelProvider` interface — the core/vendor firewall
- `model("provider/modelId", options?)` — lazy registry, single entry point
- `registerProvider(name, factory)` — custom provider registration
- Built-in: `openai`, `anthropic`, `openrouter`, `ollama`, `lmstudio`, `vllm`
- Fallback to `generate()` when provider has no `stream()`

### Tracing ✅

- Every `RunEvent` carries: `agentName`, `turn`, `timestamp`, `durationMs`
- `run-complete` carries `totalDurationMs`
- `llm-call-end` carries full `GenerateResult` including `usage` (token counts)
- All events observable via `onEvent` or `AgentEventEmitter`

### Reliability (partial) ⚠️

- ✅ `maxTurns` loop prevention
- ✅ `AbortSignal` cancellation support
- ✅ Unknown tool / invalid args → structured error (no crash)
- ❌ Automatic retries on model call failure
- ❌ Per-call timeout
- ❌ Model fallback (try provider A, fall back to provider B on error)

---

## Remaining Phases

---

### Phase 7 — Structured Output

**Goal:** Allow developers to specify a Zod schema for the final response.
The runner validates the output, retries if invalid, and infers TypeScript types.

**Files to create/change:**

- `src/core/output.ts` — new: `defineOutput()`, validation logic
- `src/core/runner.ts` — extend `RunOptions` with `outputSchema`, add validation + retry loop
- `src/index.ts` — export `defineOutput`

**API design:**

```ts
import { z } from "zod";
import { createAgent, run, defineOutput } from "sugam";

const SentimentSchema = defineOutput(
  z.object({
    sentiment: z.enum(["positive", "negative", "neutral"]),
    confidence: z.number().min(0).max(1),
    summary: z.string(),
  }),
);

const result = await run(agent, "Analyse this review: ...", {
  output: SentimentSchema,
});

// result.output is fully typed: { sentiment, confidence, summary }
console.log(result.output.sentiment);
```

**Implementation steps:**

1. `defineOutput(schema)` — wraps a Zod schema, adds a system prompt suffix
   instructing the model to respond with valid JSON matching the schema
2. Runner detects `outputSchema` in options → appends JSON instruction to system message
3. After model responds, attempt `JSON.parse` + `schema.parse`
4. On failure → append error message to history, re-call model (up to `maxOutputRetries`, default 2)
5. On success → attach typed `output` field to `RunResult`
6. New `RunEvent` types: `output-valid`, `output-invalid` (with validation errors)

---

### Phase 8 — Guardrails

**Goal:** Validate or block at three points: before input reaches the model,
before a tool executes, and before output is returned.

**Files to create/change:**

- `src/core/guardrail.ts` — new: `Guardrail` type, `defineGuardrail()`
- `src/core/agent.ts` — add `inputGuardrails`, `outputGuardrails`, `toolGuardrails` to `AgentConfig`
- `src/core/runner.ts` — check guardrails at the right points in the loop
- `src/index.ts` — export guardrail types

**API design:**

```ts
import { defineGuardrail, createAgent } from "sugam";

// Input guardrail — runs before the model is called
const noProfanity = defineGuardrail({
  name: "no-profanity",
  type: "input",
  validate: async (input) => {
    if (input.includes("badword")) {
      return { blocked: true, reason: "Profanity detected" };
    }
    return { blocked: false };
  },
});

// Tool guardrail — runs before a specific tool executes
const safeDeleteOnly = defineGuardrail({
  name: "safe-delete",
  type: "tool",
  toolName: "delete_file",
  validate: async (args) => {
    if (args.path.startsWith("/system")) {
      return { blocked: true, reason: "Cannot delete system files" };
    }
    return { blocked: false };
  },
});

// Output guardrail — runs before result is returned
const noSecrets = defineGuardrail({
  name: "no-secrets",
  type: "output",
  validate: async (output) => {
    if (/sk-[a-zA-Z0-9]{20,}/.test(output)) {
      return { blocked: true, reason: "API key detected in output" };
    }
    return { blocked: false };
  },
});

const agent = createAgent({
  name: "Safe Agent",
  instructions: "...",
  model: model("openai/gpt-4o-mini"),
  inputGuardrails: [noProfanity],
  toolGuardrails: [safeDeleteOnly],
  outputGuardrails: [noSecrets],
});
```

**Implementation steps:**

1. `defineGuardrail()` — typed config object with `validate()` returning `{ blocked, reason }`
2. Runner checks input guardrails before the first LLM call — throws `GuardrailError` if blocked
3. `executeTool()` checks tool guardrails before running — returns structured error to model if blocked
4. Runner checks output guardrails before returning `finalOutput` — throws `GuardrailError` if blocked
5. New `RunEvent` types: `guardrail-triggered` (with name, type, reason)

---

### Phase 9 — Handoffs

**Goal:** Allow one agent to hand off a task to another agent, passing context,
with loop prevention and trace visibility.

**Files to create/change:**

- `src/core/handoff.ts` — new: `Handoff` type, `defineHandoff()`
- `src/core/runner.ts` — detect handoff tool calls, execute handoff, prevent loops
- `src/index.ts` — export handoff types

**API design:**

```ts
import { createAgent, defineHandoff, run, model } from "sugam";

const billingAgent = createAgent({
  name: "Billing Agent",
  instructions: "You handle billing and payment questions.",
  model: model("openrouter/openai/gpt-4o-mini"),
});

const handoffToBilling = defineHandoff({
  name: "handoff_to_billing",
  description: "Transfer to the billing agent for payment questions.",
  targetAgent: billingAgent,
});

const triageAgent = createAgent({
  name: "Triage Agent",
  instructions:
    "Triage customer requests. Hand off to specialists when needed.",
  model: model("openrouter/openai/gpt-4o-mini"),
  handoffs: [handoffToBilling],
});

const result = await run(triageAgent, "I need help with my invoice.");
console.log(result.finalOutput);
console.log(result.handoffs); // list of handoffs that occurred
```

**Implementation steps:**

1. `defineHandoff(config)` — wraps a target agent, generates a `Tool` the model can call
2. Handoffs are registered as special tools on the agent — model calls them like any tool
3. Runner detects a handoff tool call → switches active agent → continues loop with new agent
4. Handoff depth counter — `maxHandoffs` option (default 3) prevents infinite loops
5. Context carries forward: thread messages are passed to the new agent
6. New `RunEvent` types: `handoff-start`, `handoff-complete` (with from/to agent names)
7. `RunResult` gains a `handoffs` array listing every handoff that occurred

---

### Phase 10 — Reliability

**Goal:** Add retries, per-call timeouts, and model fallback.

**Files to change:**

- `src/core/runner.ts` — wrap `generate()` calls with retry + timeout logic
- `src/core/agent.ts` — add `fallbackModel` to `AgentConfig`

**API design:**

```ts
const agent = createAgent({
  name: "Reliable Agent",
  instructions: "...",
  model: model("openai/gpt-4o-mini"),
  fallbackModel: model("openrouter/anthropic/claude-3-haiku"), // used if primary fails
});

const result = await run(agent, "Hello", {
  maxRetries: 3, // retry failed LLM calls up to 3 times
  retryDelay: 1000, // ms between retries (doubles each attempt)
  callTimeout: 30000, // ms timeout per individual LLM call
});
```

**Implementation steps:**

1. Wrap `agent.model.generate()` in a `callWithRetry()` helper — catches errors, waits `retryDelay * 2^attempt`, retries
2. `callTimeout` — race `generate()` against a `setTimeout` that rejects with `TimeoutError`
3. `fallbackModel` — if all retries on primary fail, attempt once on fallback model
4. New `RunEvent` type: `llm-call-retry` (with attempt number and error)

---

### Phase 11 — SDK Name + Package Config

**Goal:** Give the SDK an original name, update `package.json` and all imports.

**Steps:**

1. Pick a name (e.g. `sugam`, `kira-sdk`, `flowagent` — your choice)
2. Update `package.json` `name` field
3. Update `README.md` install instructions
4. No source file changes needed — internal imports use relative paths

---

### Phase 12 — Documentation

**Goal:** Hosted docs a developer can use without reading source code.

**Sections to cover:**

- Installation & quick start
- `createAgent` API reference
- `defineTool` + Zod schemas
- `run` / `runStream` options
- `Thread` / `ThreadStore` memory
- `AgentEventEmitter` observability
- Structured output
- Guardrails
- Handoffs
- Provider setup (OpenAI, Anthropic, OpenRouter, local)
- Custom providers
- Error handling & reliability
- At least 3 working examples

---

## File Structure (current + planned)

```
src/
  core/
    agent.ts         ✅ AgentConfig, Agent class, createAgent()
    runner.ts        ✅ run(), runStream(), tool loop, thread support
    message.ts       ✅ Message union types + helpers
    tool.ts          ✅ Tool class, defineTool(), Zod→JSON schema
    thread.ts        ✅ Thread, ThreadStore interface, InMemoryThreadStore
    model.ts         ✅ model(), registerProvider(), lazy registry
    provider.ts      ✅ ModelProvider interface, GenerateInput/Result, StreamEvent
    output.ts        ❌ Phase 7 — defineOutput(), structured output validation
    guardrail.ts     ❌ Phase 8 — defineGuardrail(), GuardrailError
    handoff.ts       ❌ Phase 9 — defineHandoff(), handoff loop logic
  providers/
    openai.ts        ✅ OpenAI adapter
    anthropic.ts     ✅ Anthropic adapter
    openrouter.ts    ✅ OpenRouter adapter
    compatible.ts    ✅ Ollama / LM Studio / vLLM adapters
  events/
    emitter.ts       ✅ AgentEventEmitter class
  index.ts           ✅ Public exports
examples/
  basic-agent.ts         ✅ Single-turn, no tools
  weather-agent.ts       ✅ Tool calling + EventEmitter observability
  streaming-chat.ts      ✅ runStream() demo
  memory-chat.ts         ✅ Thread-based multi-turn memory
  local-model.ts         ✅ Ollama local model
  test-providers.ts      ✅ Multi-provider smoke test
  structured-output.ts   ❌ Phase 7
  guardrails.ts          ❌ Phase 8
  handoffs.ts            ❌ Phase 9
```

---

## Implementation Order

| Phase | Feature           | Why this order                              |
| ----- | ----------------- | ------------------------------------------- |
| 7     | Structured Output | Self-contained, builds on existing Zod work |
| 8     | Guardrails        | Additive to runner, no new dependencies     |
| 9     | Handoffs          | Builds on runner + tool system              |
| 10    | Reliability       | Wraps existing generate() calls             |
| 11    | SDK Name          | Rename before publishing                    |
| 12    | Documentation     | After all features stable                   |
