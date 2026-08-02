/**
 * examples/local-model.ts
 *
 * Demonstrates running the same agent against a locally hosted model via Ollama.
 * The agent definition and tool are identical to weather-agent.ts — only the
 * model() call changes.
 *
 * Prerequisites:
 *   1. Install Ollama: https://ollama.com
 *   2. Pull a model: ollama pull llama3.1
 *   3. Ollama runs at http://localhost:11434 by default
 *
 * Build first, then run:
 *   npm run build
 *   npm run example:local
 *
 * Override the base URL if your Ollama runs elsewhere:
 *   OLLAMA_BASE_URL=http://my-server:11434/v1 npm run example:local
 */

import { z } from "zod";
import { createAgent, defineTool, model, run } from "../src/index.js";

const getWeather = defineTool({
  name: "get_weather",
  description: "Get the current weather for a given city.",
  parameters: z.object({
    city: z.string().describe("The city name"),
  }),
  execute: async ({ city }) => {
    const data: Record<string, { tempC: number; condition: string }> = {
      tokyo:    { tempC: 28, condition: "partly cloudy" },
      london:   { tempC: 15, condition: "rainy" },
      new_york: { tempC: 22, condition: "sunny" },
    };
    const key = city.toLowerCase().replace(/\s+/g, "_");
    return data[key] ?? { tempC: 20, condition: "unknown" };
  },
});

const agent = createAgent({
  name: "Local Weather Agent",
  instructions: "You are a helpful assistant. Use the get_weather tool to answer weather questions.",
  // Switch to "ollama/mistral" or any model you have pulled locally
  model: model("ollama/llama3.1"),
  tools: [getWeather],
});

console.log("=".repeat(60));
console.log("Local Model (Ollama) — Phase 3 demo");
console.log("=".repeat(60));

const result = await run(agent, "What is the weather like in Tokyo?", {
  onEvent: (event) => {
    switch (event.type) {
      case "llm-call-start":
        console.log(`\n[turn ${event.turn}] → LLM call`);
        break;
      case "llm-call-end":
        console.log(`[turn ${event.turn}] ← finish: ${event.result.finishReason} | tool calls: ${event.result.toolCalls.length}`);
        break;
      case "tool-call-start":
        console.log(`[turn ${event.turn}] ⚙  ${event.toolName}(${JSON.stringify(event.args)})`);
        break;
      case "tool-call-end":
        console.log(`[turn ${event.turn}] ✓  → ${JSON.stringify(event.result)}`);
        break;
      case "run-complete":
        console.log(`\n[done] ${event.turns} turn(s)`);
        break;
    }
  },
});

console.log("\n" + "─".repeat(60));
console.log("Final output:\n");
console.log(result.finalOutput);
