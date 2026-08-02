/**
 * examples/basic-agent.ts
 *
 * Phase 1 smoke test — single-turn, no tools.
 *
 * Run with an OpenRouter key:
 *   OPENROUTER_API_KEY=sk-or-... npx ts-node --esm examples/basic-agent.ts
 *
 * Or after building:
 *   OPENROUTER_API_KEY=sk-or-... node dist/examples/basic-agent.js
 */

import { createAgent, model, run } from "../src/index.js";

// OpenRouter exposes an OpenAI-compatible endpoint — the OpenAI adapter works
// as-is, just pointed at a different baseURL with an OpenRouter key.
const agent = createAgent({
  name: "Basic Agent",
  instructions: "You are a concise assistant. Keep answers to one sentence.",
  model: model("openai/gpt-4o-mini", {
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
  }),
});

const result = await run(agent, "What is the capital of France?", {
  onEvent: (event) => {
    switch (event.type) {
      case "llm-call-start":
        console.log(`[turn ${event.turn}] → calling model...`);
        break;
      case "llm-call-end":
        console.log(
          `[turn ${event.turn}] ← received (finish: ${event.result.finishReason})`,
        );
        break;
      case "run-complete":
        console.log(`[done] ${event.turns} turn(s)`);
        break;
    }
  },
});

console.log("\nFinal output:", result.finalOutput);
console.log("Turns used:  ", result.turns);
console.log("Messages:    ", result.messages.length);
