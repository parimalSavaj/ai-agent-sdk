# Sugam

**A TypeScript AI agent SDK built from scratch.**

Sugam (*Sanskrit: smooth path, easy access*) gives you a clean, composable API to build AI agents with tools, memory, streaming, guardrails, handoffs, and structured output — without locking you into a single model provider.

```ts
import { createAgent, model, run, defineTool } from "sugam";
import { z } from "zod";

const getWeather = defineTool({
  name: "get_weather",
  description: "Get current weather for a city",
  parameters: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, tempC: 22, condition: "sunny" }),
});

const agent = createAgent({
  name: "Weather Agent",
  instructions: "Help users with weather questions.",
  model: model("openai/gpt-4o-mini"),
  tools: [getWeather],
});

const result = await run(agent, "What's the weather in Tokyo?");
console.log(result.finalOutput);
```

---

## Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Model Providers](#model-providers)
- [Tools](#tools)
- [Running an Agent](#running-an-agent)
- [Streaming](#streaming)
- [Memory & Sessions](#memory--sessions)
- [Structured Output](#structured-output)
- [Guardrails](#guardrails)
- [Handoffs](#handoffs)
- [Observability](#observability)
- [Reliability](#reliability)
- [Custom Providers](#custom-providers)
- [API Reference](#api-reference)
- [Error Handling](#error-handling)

---

## Installation

```bash
npm install sugam zod
```

Install provider SDKs only for the providers you use:

```bash
npm install openai                # OpenAI, OpenRouter, Ollama, LM Studio, vLLM
npm install @anthropic-ai/sdk     # Anthropic Claude
```

---

## Quick Start

```ts
import { createAgent, model, run } from "sugam";

const agent = createAgent({
  name: "Assistant",
  instructions: "You are a helpful assistant.",
  model: model("openai/gpt-4o-mini"),
});

const result = await run(agent, "What is the capital of France?");
console.log(result.finalOutput); // "The capital of France is Paris."
```

Set your API key in `.env`:

```
OPENAI_API_KEY=sk-...
```

Run with Node's built-in env loader (Node 20+):

```bash
node --env-file=.env dist/index.js
```

---

## Model Providers

All providers are accessed through a single `model("provider/modelId")` function. The provider SDK is loaded lazily — unused providers are never imported.

```ts
import { model } from "sugam";

// OpenAI
model("openai/gpt-4o-mini")
model("openai/gpt-4o")

// Anthropic
model("anthropic/claude-sonnet-4-5")
model("anthropic/claude-3-haiku")

// OpenRouter (access 200+ models with one key)
model("openrouter/openai/gpt-4o-mini")
model("openrouter/anthropic/claude-3-haiku")
model("openrouter/meta-llama/llama-3.1-8b-instruct")

// Ollama (local)
model("ollama/llama3.1")
model("ollama/mistral")

// LM Studio (local)
model("lmstudio/qwen2.5-7b")

// vLLM (self-hosted — baseURL required)
model("vllm/meta-llama-3-8b", { baseURL: "http://localhost:8000/v1" })
```

**Environment variables:**

| Provider | Variable |
|---|---|
| OpenAI | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Ollama | `OLLAMA_BASE_URL` (optional, default: `http://localhost:11434/v1`) |

**OpenRouter tip:** The `model()` string splits on the first `/` only, so multi-slash OpenRouter model IDs work correctly:

```ts
model("openrouter/anthropic/claude-3.7-sonnet")
//    provider = "openrouter"
//    modelId  = "anthropic/claude-3.7-sonnet"
```

---

## Tools

Tools let the model call your functions. Define them with a Zod schema — Sugam converts it to JSON Schema automatically and validates all arguments at runtime.

```ts
import { defineTool } from "sugam";
import { z } from "zod";

const searchWeb = defineTool({
  name: "search_web",
  description: "Search the web and return top results.",
  parameters: z.object({
    query: z.string().describe("The search query"),
    maxResults: z.number().int().min(1).max(10).optional(),
  }),
  execute: async ({ query, maxResults = 3 }) => {
    // your implementation
    return { results: [] };
  },
});

const agent = createAgent({
  name: "Research Agent",
  instructions: "Help users find information online.",
  model: model("openai/gpt-4o-mini"),
  tools: [searchWeb],
});
```

- `parameters` is a Zod schema — the type of `execute`'s argument is inferred automatically
- `execute` must return a `Promise<unknown>` — the result is serialised to JSON and fed back to the model
- If the model passes invalid arguments, Sugam returns a structured error to the model so it can self-correct
- Tools are async by default — network calls, database queries, file I/O all work

---

## Running an Agent

### `run()` — non-streaming

```ts
import { run } from "sugam";

const result = await run(agent, "Write a haiku about TypeScript", {
  maxTurns: 10,       // max model calls per run (default: 10)
  temperature: 0.7,   // sampling temperature (default: provider default)
  maxTokens: 1000,    // max tokens per call
  signal: controller.signal, // AbortSignal for cancellation
});

console.log(result.finalOutput);  // final text answer
console.log(result.messages);     // full conversation history
console.log(result.turns);        // number of model calls made
console.log(result.handoffs);     // handoffs that occurred (Phase 9)
```

### The agent loop

On each turn Sugam:

1. Calls the model with the current message history
2. If the model requests tool calls → executes each tool → appends results → loops back
3. If the model returns a plain text answer → returns it as `finalOutput`
4. If `maxTurns` is exceeded → returns whatever text was last produced

---

## Streaming

`runStream()` is an `AsyncGenerator` that yields events as they arrive from the model. Text tokens are yielded immediately — no buffering.

```ts
import { runStream } from "sugam";

for await (const event of runStream(agent, "Tell me a story")) {
  switch (event.type) {
    case "text-delta":
      process.stdout.write(event.delta);  // print each token as it arrives
      break;

    case "tool-call-start":
      console.log(`\n[calling ${event.toolName}...]`);
      break;

    case "tool-call-end":
      console.log(`[result: ${JSON.stringify(event.result)}]`);
      break;

    case "turn-finish":
      // one model turn completed (finishReason: "stop" | "tool_calls")
      break;

    case "finish":
      console.log("\nDone:", event.finalOutput);
      console.log("Turns:", event.turns);
      break;
  }
}
```

**`RunStreamEvent` types:**

| Type | Fields | Description |
|---|---|---|
| `text-delta` | `delta` | A text token from the model |
| `tool-call-start` | `turn`, `toolName`, `args` | Tool about to execute |
| `tool-call-end` | `turn`, `toolName`, `result`, `durationMs` | Tool completed |
| `turn-finish` | `turn`, `finishReason` | One model turn done |
| `finish` | `finalOutput`, `messages`, `turns` | Entire run complete |

Tool calling works inside `runStream()` exactly like `run()` — the loop continues automatically after tool execution.

---

## Memory & Sessions

`Thread` stores conversation history across multiple `run()` calls. Pass the same thread to maintain context.

```ts
import { createThread, run } from "sugam";

const thread = createThread();

// Turn 1 — introduce a fact
await run(agent, "My name is Alex and I love TypeScript.", { thread });

// Turn 2 — the agent remembers
const result = await run(agent, "What is my name?", { thread });
console.log(result.finalOutput); // "Your name is Alex."

// Check thread state
console.log(thread.id);       // "thread_1234_abc"
console.log(thread.length);   // number of stored messages
```

**What gets stored:**
- User messages
- Assistant responses
- Tool call requests and results

**What does NOT get stored:**
- System messages (agent instructions) — prepended fresh on every run

This means you can update an agent's `instructions` and the change takes effect immediately on the next `run()` call without touching stored history.

### Custom storage backend

`ThreadStore` is an interface — swap `InMemoryThreadStore` for any database:

```ts
import { Thread, InMemoryThreadStore } from "sugam";
import type { ThreadStore } from "sugam";

class PostgresThreadStore implements ThreadStore {
  async get(threadId: string): Promise<Thread | undefined> {
    const row = await db.query("SELECT * FROM threads WHERE id = $1", [threadId]);
    if (!row) return undefined;
    const thread = new Thread(threadId);
    thread.addMessages(JSON.parse(row.messages));
    return thread;
  }

  async save(thread: Thread): Promise<void> {
    await db.query(
      "INSERT INTO threads (id, messages) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET messages = $2",
      [thread.id, JSON.stringify(thread.getMessages())]
    );
  }

  async delete(threadId: string): Promise<void> {
    await db.query("DELETE FROM threads WHERE id = $1", [threadId]);
  }

  async list(): Promise<string[]> {
    const rows = await db.query("SELECT id FROM threads");
    return rows.map((r: { id: string }) => r.id);
  }
}
```

---

## Structured Output

Force the model to respond with a typed JSON object matching a Zod schema. Sugam validates the response and retries automatically if the model produces invalid output.

```ts
import { defineOutput, run } from "sugam";
import { z } from "zod";

const SentimentOutput = defineOutput(
  z.object({
    sentiment: z.enum(["positive", "negative", "neutral"]),
    confidence: z.number().min(0).max(1),
    summary: z.string(),
    keywords: z.array(z.string()),
  })
);

const result = await run(agent, "Analyse this review: 'Great product!'", {
  output: SentimentOutput,
  maxOutputRetries: 2,  // retry up to 2 times if model returns invalid JSON
});

// result.output is fully typed — TypeScript infers the shape from the schema
console.log(result.output?.sentiment);   // "positive"
console.log(result.output?.confidence);  // 0.95
```

**How it works:**

1. Sugam appends the JSON schema to the system prompt
2. The model responds with a JSON object
3. Sugam validates against the Zod schema
4. On failure — appends the validation errors to history, asks the model to fix it
5. On success — attaches the typed value to `result.output`

**Observability:**

```ts
emitter.on("output-valid", (e) => console.log(`✓ Valid on attempt ${e.attempt}`));
emitter.on("output-invalid", (e) => console.warn(`✗ Invalid:`, e.issues));
```

---

## Guardrails

Validate or block at three points in the agent loop — before input reaches the model, before a tool runs, and before output is returned.

```ts
import { defineGuardrail, createAgent, GuardrailError } from "sugam";

// 1. Input guardrail — runs before the first LLM call
const noEmptyInput = defineGuardrail({
  name: "no-empty-input",
  type: "input",
  validate: (input) => {
    if (!(input as string).trim()) {
      return { blocked: true, reason: "Input cannot be empty" };
    }
    return { blocked: false };
  },
});

// 2. Tool guardrail — runs before a specific tool executes
const safeDeleteOnly = defineGuardrail({
  name: "safe-delete",
  type: "tool",
  toolName: "delete_file",   // omit to apply to all tools
  validate: (args) => {
    const { path } = args as { path: string };
    if (!path.startsWith("/tmp")) {
      return { blocked: true, reason: "Deletion outside /tmp not allowed" };
    }
    return { blocked: false };
  },
});

// 3. Output guardrail — runs before the result is returned
const noSecrets = defineGuardrail({
  name: "no-secrets",
  type: "output",
  validate: (output) => {
    if (/sk-[a-zA-Z0-9]{20,}/.test(output as string)) {
      return { blocked: true, reason: "API key detected in output" };
    }
    return { blocked: false };
  },
});

const agent = createAgent({
  name: "Safe Agent",
  instructions: "...",
  model: model("openai/gpt-4o-mini"),
  inputGuardrails: [noEmptyInput],
  toolGuardrails: [safeDeleteOnly],
  outputGuardrails: [noSecrets],
});

// Catch blocked runs
try {
  const result = await run(agent, userMessage);
} catch (err) {
  if (err instanceof GuardrailError) {
    console.log(`Blocked by "${err.guardrailName}": ${err.reason}`);
  }
}
```

**Behaviour by type:**

| Type | On block |
|---|---|
| `input` | Throws `GuardrailError` — LLM is never called |
| `tool` | Returns structured error to the model — model can self-correct |
| `output` | Throws `GuardrailError` — result is not returned to caller |

**Observability:**

```ts
emitter.on("guardrail-triggered", (e) => {
  console.log(`Guardrail "${e.guardrailName}" [${e.guardrailType}]: ${e.reason}`);
});
```

---

## Handoffs

Allow one agent to delegate a task to another. The model calls a handoff like a regular tool — Sugam detects it, switches the active agent, and continues the loop with the full conversation history transferred.

```ts
import { createAgent, defineHandoff, run, model } from "sugam";

// Specialist agents
const billingAgent = createAgent({
  name: "Billing Agent",
  instructions: "You handle payments, invoices, and refunds.",
  model: model("openai/gpt-4o-mini"),
});

const technicalAgent = createAgent({
  name: "Technical Agent",
  instructions: "You handle bugs and technical issues.",
  model: model("openai/gpt-4o-mini"),
});

// Define handoffs
const handoffToBilling = defineHandoff({
  name: "handoff_to_billing",
  description: "Transfer to Billing Agent for payment questions.",
  targetAgent: billingAgent,
});

const handoffToTechnical = defineHandoff({
  name: "handoff_to_technical",
  description: "Transfer to Technical Agent for product issues.",
  targetAgent: technicalAgent,
});

// Triage agent with handoffs
const triageAgent = createAgent({
  name: "Triage Agent",
  instructions: "Route customers to the right specialist.",
  model: model("openai/gpt-4o-mini"),
  handoffs: [handoffToBilling, handoffToTechnical],
});

const result = await run(triageAgent, "I was charged twice.", {
  maxHandoffs: 3,  // prevent infinite loops (default: 3)
});

console.log(result.finalOutput);
console.log(result.handoffs);
// [{ fromAgent: "Triage Agent", toAgent: "Billing Agent", context: "...", timestamp: "..." }]
```

**How handoffs work:**
1. Handoffs are registered as tools on the agent
2. When the model calls one, Sugam intercepts it before `executeTool()`
3. The full message history carries forward — the new agent sees everything
4. `maxHandoffs` prevents `A → B → A → ...` loops — throws `HandoffError` if exceeded

**Observability:**

```ts
emitter.on("handoff-start", (e) => {
  console.log(`Handoff #${e.handoffCount}: ${e.fromAgent} → ${e.toAgent}`);
  console.log(`Context: ${e.context}`);
});
```

---

## Observability

Two ways to observe every step inside a run — they compose and can be used together.

### Option 1 — inline `onEvent` callback

```ts
const result = await run(agent, input, {
  onEvent: (event) => {
    console.log(event.type, event.timestamp);
  },
});
```

### Option 2 — `AgentEventEmitter` (multi-subscriber)

```ts
import { AgentEventEmitter } from "sugam";

const emitter = new AgentEventEmitter();

// Subscribe to specific events
emitter.on("llm-call-end", (e) => {
  metrics.recordLatency(e.durationMs);
  metrics.recordTokens(e.result.usage?.totalTokens ?? 0);
});

emitter.on("tool-call-end", (e) => {
  console.log(`${e.toolName} took ${e.durationMs}ms`);
});

// Subscribe to all events (catch-all)
emitter.onAny((e) => logger.debug("[sugam]", e.type, e));

// Unsubscribe
emitter.off("llm-call-end", myHandler);
emitter.clear(); // remove all listeners

await run(agent, input, { emitter });
```

Both `onEvent` and `emitter` fire for the same events — pass both if needed.

### Full `RunEvent` reference

Every event carries `agentName` and `timestamp`.

| Event | Extra fields | When |
|---|---|---|
| `llm-call-start` | `turn`, `messages` | Before each model call |
| `llm-call-end` | `turn`, `result`, `durationMs` | After each model call |
| `llm-call-retry` | `turn`, `attempt`, `error`, `delayMs`, `usingFallback` | Before each retry |
| `tool-call-start` | `turn`, `toolName`, `args` | Before each tool runs |
| `tool-call-end` | `turn`, `toolName`, `result`, `durationMs` | After each tool |
| `output-valid` | `attempt`, `output` | Structured output passed validation |
| `output-invalid` | `attempt`, `rawOutput`, `issues` | Structured output failed validation |
| `guardrail-triggered` | `guardrailName`, `guardrailType`, `blockedValue`, `reason` | Any guardrail blocked |
| `handoff-start` | `fromAgent`, `toAgent`, `context`, `handoffCount` | Before handoff |
| `handoff-complete` | `fromAgent`, `toAgent` | After handoff |
| `run-complete` | `finalOutput`, `turns`, `totalDurationMs` | Entire run done |

---

## Reliability

Add retries, timeouts, and a fallback model to any run.

```ts
const agent = createAgent({
  name: "Reliable Agent",
  instructions: "...",
  model: model("openai/gpt-4o-mini"),
  fallbackModel: model("openrouter/anthropic/claude-3-haiku"), // used if primary fails
});

const result = await run(agent, "Hello", {
  maxRetries: 3,       // retry failed LLM calls up to 3 times (default: 1)
  retryDelay: 1000,    // base delay in ms — doubles each attempt (default: 1000)
  callTimeout: 30000,  // ms timeout per individual LLM call (default: none)
});
```

**Retry strategy:** exponential backoff with ±10% jitter, capped at 30 seconds.

```
attempt 1 fails → wait 1000ms
attempt 2 fails → wait 2000ms
attempt 3 fails → wait 4000ms → try fallbackModel once
```

**Errors thrown:**

```ts
import { RetryError, TimeoutError } from "sugam";

try {
  await run(agent, input, { maxRetries: 3, callTimeout: 5000 });
} catch (err) {
  if (err instanceof TimeoutError) {
    console.log(`Timed out after ${err.timeoutMs}ms`);
  }
  if (err instanceof RetryError) {
    console.log(`Failed after ${err.attempts} attempts: ${err.cause.message}`);
  }
}
```

---

## Custom Providers

Implement the `ModelProvider` interface directly and pass it to `createAgent` — no registration needed.

```ts
import type { ModelProvider, GenerateInput, GenerateResult } from "sugam";

const myProvider: ModelProvider = {
  providerId: "my-llm",
  modelId: "internal-v1",

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const response = await fetch("https://my-llm-api.com/v1/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: input.messages }),
    });
    const data = await response.json() as { text: string };
    return {
      text: data.text,
      toolCalls: [],
      finishReason: "stop",
    };
  },
};

const agent = createAgent({
  name: "Internal Agent",
  instructions: "...",
  model: myProvider,
});
```

For reuse across an app, register the provider so it's reachable via the `model()` string:

```ts
import { registerProvider } from "sugam";

registerProvider("my-llm", (modelId, options) => ({
  providerId: "my-llm",
  modelId,
  async generate(input) { /* ... */ },
}));

// Now usable everywhere
const agent = createAgent({
  model: model("my-llm/internal-v1"),
});
```

---

## API Reference

### `createAgent(config)`

Creates a stateless, reusable agent definition.

```ts
type AgentConfig = {
  name: string;
  instructions: string;
  model: ModelProvider;
  tools?: Tool[];
  fallbackModel?: ModelProvider;
  handoffs?: Handoff[];
  inputGuardrails?: InputGuardrail[];
  toolGuardrails?: ToolGuardrail[];
  outputGuardrails?: OutputGuardrail[];
};
```

---

### `model(spec, options?)`

Resolves a provider/model string to a `ModelProvider`.

```ts
model("openai/gpt-4o-mini")
model("openrouter/anthropic/claude-3-haiku")
model("ollama/llama3.1")
model("vllm/my-model", { baseURL: "http://localhost:8000/v1", apiKey: "..." })
```

---

### `run(agent, input, options?)`

Runs an agent to completion, returns a `RunResult`.

```ts
type RunOptions = {
  maxTurns?: number;           // default: 10
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  thread?: Thread;
  output?: OutputSchema;
  maxOutputRetries?: number;   // default: 2
  maxHandoffs?: number;        // default: 3
  maxRetries?: number;         // default: 1
  retryDelay?: number;         // default: 1000 (ms)
  callTimeout?: number;        // default: none
  onEvent?: (event: RunEvent) => void;
  emitter?: AgentEventEmitter;
};

type RunResult<TOutput> = {
  finalOutput: string;
  messages: Message[];
  turns: number;
  output?: TOutput;            // only set when options.output was used
  handoffs: HandoffRecord[];
};
```

---

### `runStream(agent, input, options?)`

Same options as `run()`. Returns `AsyncGenerator<RunStreamEvent>`.

---

### `defineTool(config)`

```ts
defineTool({
  name: string;
  description: string;
  parameters: ZodObject;   // must be z.object({...}) at the top level
  execute: (args) => Promise<unknown>;
})
```

---

### `defineOutput(schema)`

```ts
const MyOutput = defineOutput(z.object({ ... }));

const result = await run(agent, input, { output: MyOutput });
result.output; // typed as z.infer<typeof schema>
```

---

### `defineGuardrail(config)`

```ts
defineGuardrail({
  name: string;
  type: "input" | "tool" | "output";
  toolName?: string;           // tool guardrails only — omit for all tools
  validate: (value) => { blocked: false } | { blocked: true; reason: string };
})
```

---

### `defineHandoff(config)`

```ts
defineHandoff({
  name: string;
  description: string;
  targetAgent: Agent;
  contextMessage?: string;
})
```

---

### `createThread(id?)`

Creates a new `Thread` and registers it in the default in-memory store.

```ts
const thread = createThread();
thread.id           // "thread_1234_abc"
thread.length       // number of stored messages
thread.getMessages() // Message[]
thread.addMessages(messages)
thread.clear()
```

---

### `AgentEventEmitter`

```ts
const emitter = new AgentEventEmitter();
emitter.on(eventType, handler)     // subscribe to one event type
emitter.off(eventType, handler)    // unsubscribe
emitter.onAny(handler)             // catch-all
emitter.offAny(handler)
emitter.clear(eventType?)          // remove all listeners
emitter.listenerCount(eventType)   // number of registered listeners
```

---

## Error Handling

| Error class | When thrown | Key fields |
|---|---|---|
| `GuardrailError` | Input or output guardrail blocks | `guardrailName`, `guardrailType`, `reason` |
| `StructuredOutputError` | `defineOutput` validation fails after all retries | `rawOutput`, `validationError`, `attempts` |
| `HandoffError` | `maxHandoffs` limit exceeded | `fromAgent`, `toAgent`, `handoffCount` |
| `RetryError` | All retry attempts failed | `cause`, `attempts` |
| `TimeoutError` | LLM call exceeded `callTimeout` | `timeoutMs` |

```ts
import {
  GuardrailError,
  StructuredOutputError,
  HandoffError,
  RetryError,
  TimeoutError,
} from "sugam";

try {
  await run(agent, input);
} catch (err) {
  if (err instanceof GuardrailError)       { /* input/output blocked */ }
  if (err instanceof StructuredOutputError) { /* invalid JSON after retries */ }
  if (err instanceof HandoffError)         { /* too many handoffs */ }
  if (err instanceof RetryError)           { /* model kept failing */ }
  if (err instanceof TimeoutError)         { /* model too slow */ }
}
```

---

## Examples

All examples are in the `examples/` directory. Build first, then run:

```bash
npm run build
```

| Script | What it shows |
|---|---|
| `npm run example:basic` | Single-turn, no tools |
| `npm run example:weather` | Tool calling + EventEmitter observability |
| `npm run example:stream` | `runStream()` with tool calling |
| `npm run example:memory` | Thread-based multi-turn memory |
| `npm run example:structured` | `defineOutput()` with Zod schema validation |
| `npm run example:guardrails` | Input, tool, and output guardrails |
| `npm run example:handoffs` | Multi-agent triage with handoffs |
| `npm run example:reliability` | Retries, timeout, and fallback model |
| `npm run example:local` | Same agent running against Ollama |
| `npm run example:test-providers` | OpenAI, Anthropic, OpenRouter smoke test |

---

## License

MIT
