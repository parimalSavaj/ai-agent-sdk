/**
 * examples/test-providers.ts — Phase 3 provider smoke test
 *
 * Build first: npm run build
 * Run: npm run example:test-providers
 */
import { createAgent, model, run } from "../src/index.js";

// Test 1: openrouter provider (native)
console.log("--- Test 1: openrouter/openai/gpt-4o-mini ---");
const agent1 = createAgent({
  name: "Test",
  instructions: "You are concise. One sentence answers only.",
  model: model("openrouter/openai/gpt-4o-mini"),
});
const r1 = await run(agent1, "What is 2 + 2?");
console.log("Provider :", agent1.model.providerId);
console.log("Output   :", r1.finalOutput);

// Test 2: Anthropic claude-3-haiku via OpenRouter
console.log("\n--- Test 2: openrouter/anthropic/claude-3-haiku ---");
const agent2 = createAgent({
  name: "Test",
  instructions: "You are concise. One sentence answers only.",
  model: model("openrouter/anthropic/claude-3-haiku"),
});
const r2 = await run(agent2, "What is the capital of Japan?");
console.log("Provider :", agent2.model.providerId);
console.log("Output   :", r2.finalOutput);
