/**
 * examples/memory-chat.ts
 *
 * Phase 6 demo — Thread-based conversation memory.
 *
 * Shows:
 *   - createThread() creating a persistent conversation thread
 *   - Multiple run() calls on the same thread maintaining history
 *   - The agent correctly recalling information from earlier in the thread
 *   - thread.length growing with each turn
 *   - Multiple independent threads running concurrently without interference
 *
 * Build first, then run:
 *   npm run build
 *   npm run example:memory
 */

import {
  createAgent,
  model,
  run,
  createThread,
} from "../src/index.js";

// ── Agent ─────────────────────────────────────────────────────────────────────

const agent = createAgent({
  name: "Memory Agent",
  instructions:
    "You are a helpful assistant with a good memory. " +
    "Remember everything the user tells you during this conversation.",
  model: model("openrouter/openai/gpt-4o-mini"),
});

// ── Demo 1: single thread, multi-turn conversation ────────────────────────────

console.log("=".repeat(60));
console.log("Demo 1 — Multi-turn memory");
console.log("=".repeat(60));

const thread = createThread();
console.log(`Thread id: ${thread.id}\n`);

// Turn 1 — introduce a fact
const r1 = await run(agent, "My name is Alex and I love TypeScript.", { thread });
console.log(`[turn 1] User: My name is Alex and I love TypeScript.`);
console.log(`[turn 1] Agent: ${r1.finalOutput}`);
console.log(`         Thread messages: ${thread.length}\n`);

// Turn 2 — ask something unrelated first
const r2 = await run(agent, "What is the capital of France?", { thread });
console.log(`[turn 2] User: What is the capital of France?`);
console.log(`[turn 2] Agent: ${r2.finalOutput}`);
console.log(`         Thread messages: ${thread.length}\n`);

// Turn 3 — recall the fact from turn 1
const r3 = await run(agent, "What is my name and what do I love?", { thread });
console.log(`[turn 3] User: What is my name and what do I love?`);
console.log(`[turn 3] Agent: ${r3.finalOutput}`);
console.log(`         Thread messages: ${thread.length}\n`);

// ── Demo 2: two independent threads — no cross-contamination ─────────────────

console.log("=".repeat(60));
console.log("Demo 2 — Independent threads");
console.log("=".repeat(60));

const threadA = createThread();
const threadB = createThread();

// Each thread gets a different name
await run(agent, "My name is Bob.", { thread: threadA });
await run(agent, "My name is Carol.", { thread: threadB });

const rA = await run(agent, "What is my name?", { thread: threadA });
const rB = await run(agent, "What is my name?", { thread: threadB });

console.log(`Thread A → ${rA.finalOutput}`);
console.log(`Thread B → ${rB.finalOutput}`);
console.log();
console.log(`Thread A messages: ${threadA.length}`);
console.log(`Thread B messages: ${threadB.length}`);
