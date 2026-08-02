/**
 * examples/weather-agent.ts
 *
 * Phase 5 demo — AgentEventEmitter subscription-style observability.
 *
 * Shows two ways to observe a run:
 *   1. emitter.on("event-type", handler) — subscribe per event type
 *   2. emitter.onAny(handler)            — catch-all for logging/metrics
 *
 * Every event now carries agentName, timestamp, and durationMs.
 *
 * Build first, then run:
 *   npm run build
 *   npm run example:weather
 */

import { z } from "zod";
import {
  createAgent,
  defineTool,
  model,
  run,
  AgentEventEmitter,
} from "../src/index.js";

// ── Tool definitions ──────────────────────────────────────────────────────────

const getWeather = defineTool({
  name: "get_weather",
  description: "Get current weather for a city.",
  parameters: z.object({
    city: z.string().describe("The city name, e.g. Tokyo"),
  }),
  execute: async ({ city }) => {
    const data: Record<string, { tempC: number; condition: string }> = {
      tokyo: { tempC: 28, condition: "partly cloudy" },
      london: { tempC: 15, condition: "rainy" },
      new_york: { tempC: 22, condition: "sunny" },
      paris: { tempC: 18, condition: "overcast" },
    };
    const key = city.toLowerCase().replace(/\s+/g, "_");
    return data[key] ?? { tempC: 20, condition: "unknown" };
  },
});

const getTime = defineTool({
  name: "get_time",
  description: "Get the current local time for a city.",
  parameters: z.object({
    city: z.string().describe("The city name"),
  }),
  execute: async ({ city }) => {
    const offsets: Record<string, number> = {
      tokyo: 9,
      london: 1,
      new_york: -4,
      paris: 2,
    };
    const key = city.toLowerCase().replace(/\s+/g, "_");
    const offset = offsets[key] ?? 0;
    const local = new Date(Date.now() + offset * 3_600_000);
    return {
      city,
      localTime: local.toISOString().replace("T", " ").substring(0, 19),
      utcOffset: `UTC${offset >= 0 ? "+" : ""}${offset}`,
    };
  },
});

// ── Agent ─────────────────────────────────────────────────────────────────────

const agent = createAgent({
  name: "Weather Agent",
  instructions:
    "You are a helpful assistant. Always use tools to get weather and time data.",
  model: model("openrouter/openai/gpt-4o-mini"),
  tools: [getWeather, getTime],
});

// ── EventEmitter — subscribe before running ───────────────────────────────────

const emitter = new AgentEventEmitter();

// Subscribe to specific event types
emitter.on("llm-call-start", (e) => {
  console.log(
    `\n[${e.timestamp}] → LLM call` +
      ` | agent: ${e.agentName}` +
      ` | turn: ${e.turn}` +
      ` | messages: ${e.messages.length}`,
  );
});

emitter.on("llm-call-end", (e) => {
  console.log(
    `[${e.timestamp}] ← LLM done` +
      ` | turn: ${e.turn}` +
      ` | finish: ${e.result.finishReason}` +
      ` | tool calls: ${e.result.toolCalls.length}` +
      ` | ${e.durationMs}ms` +
      (e.result.usage ? ` | tokens: ${e.result.usage.totalTokens}` : ""),
  );
});

emitter.on("tool-call-start", (e) => {
  console.log(
    `[${e.timestamp}] ⚙  ${e.toolName}` +
      `(${JSON.stringify(e.args)})` +
      ` | turn: ${e.turn}`,
  );
});

emitter.on("tool-call-end", (e) => {
  console.log(
    `[${e.timestamp}] ✓  ${e.toolName}` +
      ` → ${JSON.stringify(e.result)}` +
      ` | ${e.durationMs}ms`,
  );
});

emitter.on("run-complete", (e) => {
  console.log(
    `\n[${e.timestamp}] ✔  run complete` +
      ` | agent: ${e.agentName}` +
      ` | turns: ${e.turns}` +
      ` | total: ${e.totalDurationMs}ms`,
  );
});

// ── Run ───────────────────────────────────────────────────────────────────────

console.log("=".repeat(60));
console.log("Weather Agent — Phase 5 observability demo");
console.log("=".repeat(60));

const result = await run(
  agent,
  "What's the weather and current time in Tokyo and London?",
  { emitter },
);

console.log("\n" + "─".repeat(60));
console.log("Final output:\n");
console.log(result.finalOutput);
console.log("\n" + "─".repeat(60));
console.log(`Turns    : ${result.turns}`);
console.log(`Messages : ${result.messages.length}`);
