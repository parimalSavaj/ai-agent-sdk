/**
 * examples/reliability.ts
 *
 * Phase 10 demo — retries, timeout, and model fallback.
 *
 * Shows:
 *   - maxRetries + retryDelay: automatic retry on failure with backoff
 *   - callTimeout: per-call timeout throwing TimeoutError
 *   - fallbackModel: switches provider when primary exhausts all retries
 *   - llm-call-retry event via AgentEventEmitter
 *
 * Build first, then run:
 *   npm run build
 *   npm run example:reliability
 */

import {
  createAgent,
  model,
  run,
  AgentEventEmitter,
  RetryError,
  TimeoutError,
} from "../src/index.js";

// ── Emitter — observe retry events ───────────────────────────────────────────

const emitter = new AgentEventEmitter();

emitter.on("llm-call-start", (e) => {
  console.log(`  [${e.agentName}] turn ${e.turn} → calling model...`);
});

emitter.on("llm-call-end", (e) => {
  console.log(
    `  [${e.agentName}] turn ${e.turn} ← done (${e.durationMs}ms, finish: ${e.result.finishReason})`,
  );
});

emitter.on("llm-call-retry", (e) => {
  console.warn(
    `  ⚠  Retry attempt ${e.attempt} for turn ${e.turn}` +
    ` | error: ${e.error}` +
    ` | delay: ${e.delayMs}ms` +
    (e.usingFallback ? " | switching to fallback model" : ""),
  );
});

emitter.on("run-complete", (e) => {
  console.log(`  ✔  Done in ${e.totalDurationMs}ms (${e.turns} turn(s))\n`);
});

// ── Demo 1: normal run with retries configured ────────────────────────────────

console.log("=".repeat(60));
console.log("Demo 1 — Normal run (retries configured but not needed)");
console.log("=".repeat(60));

const agent = createAgent({
  name: "Reliable Agent",
  instructions: "You are a concise assistant. One sentence answers only.",
  model: model("openrouter/openai/gpt-4o-mini"),
});

const r1 = await run(agent, "What is the capital of Japan?", {
  emitter,
  maxRetries: 3,
  retryDelay: 500,
  callTimeout: 30_000,
});
console.log(`  Output: ${r1.finalOutput}`);

// ── Demo 2: fallback model configured ────────────────────────────────────────
// Primary = gpt-4o-mini, fallback = claude-3-haiku (via OpenRouter).
// Both work fine here — we're testing the configuration path, not a real failure.

console.log("=".repeat(60));
console.log("Demo 2 — Fallback model configured");
console.log("=".repeat(60));

const agentWithFallback = createAgent({
  name: "Resilient Agent",
  instructions: "You are a concise assistant. One sentence answers only.",
  model: model("openrouter/openai/gpt-4o-mini"),
  fallbackModel: model("openrouter/anthropic/claude-3-haiku"),
});

const r2 = await run(agentWithFallback, "What is 15 * 15?", {
  emitter,
  maxRetries: 2,
  retryDelay: 200,
  callTimeout: 30_000,
});
console.log(`  Output: ${r2.finalOutput}`);

// ── Demo 3: very short timeout to demonstrate TimeoutError ───────────────────

console.log("=".repeat(60));
console.log("Demo 3 — Timeout simulation (1ms timeout, expects TimeoutError)");
console.log("=".repeat(60));

try {
  await run(agent, "Tell me a long story", {
    emitter,
    maxRetries: 1,
    callTimeout: 1, // 1ms — will always time out
  });
} catch (err) {
  if (err instanceof TimeoutError) {
    console.log(`  ✓ TimeoutError caught as expected: ${err.message}`);
  } else if (err instanceof RetryError) {
    console.log(`  ✓ RetryError caught (wraps timeout): ${err.message}`);
  } else {
    throw err;
  }
}

console.log("\n" + "=".repeat(60));
console.log("Done.");
