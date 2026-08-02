/**
 * examples/streaming-chat.ts
 *
 * Phase 4 demo — runStream() with tool calling.
 *
 * Shows:
 *   - Text deltas printed to stdout as they arrive (no buffering)
 *   - Tool calls executed mid-stream, next turn streamed automatically
 *   - finish event carrying the final assembled output
 *
 * Build first, then run:
 *   npm run build
 *   npm run example:stream
 */

import { z } from "zod";
import { createAgent, defineTool, model, runStream } from "../src/index.js";

// ── Tools ─────────────────────────────────────────────────────────────────────

const getWeather = defineTool({
  name: "get_weather",
  description: "Get the current weather for a city.",
  parameters: z.object({
    city: z.string().describe("City name"),
  }),
  execute: async ({ city }) => {
    const data: Record<string, { tempC: number; condition: string }> = {
      tokyo: { tempC: 28, condition: "partly cloudy" },
      london: { tempC: 15, condition: "rainy" },
      new_york: { tempC: 22, condition: "sunny" },
      paris: { tempC: 18, condition: "overcast" },
    };
    const key = city.toLowerCase().replace(/\s+/g, "_");
    // Simulate a small delay so streaming mid-tool is visible
    await new Promise((r) => setTimeout(r, 80));
    return data[key] ?? { tempC: 20, condition: "unknown" };
  },
});

// ── Agent ─────────────────────────────────────────────────────────────────────

const agent = createAgent({
  name: "Streaming Weather Agent",
  instructions:
    "You are a helpful assistant. Always use get_weather for weather questions. " +
    "Write your answer in flowing prose, not bullet points.",
  model: model("openrouter/openai/gpt-4o-mini"),
  tools: [getWeather],
});

// ── Run ───────────────────────────────────────────────────────────────────────

console.log("=".repeat(60));
console.log("Streaming Chat — Phase 4 demo");
console.log("=".repeat(60));
console.log();

let currentTurn = 0;

for await (const event of runStream(
  agent,
  "What's the weather in Tokyo and Paris right now? Give me a brief summary.",
)) {
  switch (event.type) {
    case "text-delta":
      // Print each token immediately — no newline so they run together
      process.stdout.write(event.delta);
      break;

    case "tool-call-start":
      if (event.turn !== currentTurn) {
        currentTurn = event.turn;
        process.stdout.write("\n");
      }
      console.log(
        `\n[turn ${event.turn}] ⚙  ${event.toolName}(${JSON.stringify(typeof event.args === "string" ? JSON.parse(event.args) : event.args)})`,
      );
      break;

    case "tool-call-end":
      console.log(`[turn ${event.turn}] ✓  → ${JSON.stringify(event.result)}`);
      // Small gap before next stream starts printing
      process.stdout.write("\n");
      break;

    case "turn-finish":
      // Only log non-final turns (tool_calls turns)
      if (event.finishReason !== "stop") {
        console.log(`\n[turn ${event.turn}] finish: ${event.finishReason}`);
      }
      break;

    case "finish":
      console.log("\n\n" + "─".repeat(60));
      console.log(`Turns used : ${event.turns}`);
      console.log(`Messages   : ${event.messages.length}`);
      break;
  }
}
