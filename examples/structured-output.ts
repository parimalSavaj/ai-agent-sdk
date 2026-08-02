/**
 * examples/structured-output.ts
 *
 * Phase 7 demo — structured output with schema validation and retry.
 *
 * Shows:
 *   - defineOutput() wrapping a Zod schema
 *   - result.output fully typed — TypeScript infers the shape
 *   - output-valid / output-invalid events via AgentEventEmitter
 *   - Multiple output schemas on different runs
 *
 * Build first, then run:
 *   npm run build
 *   npm run example:structured
 */

import { z } from "zod";
import {
  createAgent,
  model,
  run,
  defineOutput,
  AgentEventEmitter,
} from "../src/index.js";

// ── Agent ─────────────────────────────────────────────────────────────────────

const agent = createAgent({
  name: "Analyst Agent",
  instructions: "You are a precise analyst. Follow output format instructions exactly.",
  model: model("openrouter/openai/gpt-4o-mini"),
});

// ── Emitter — observe output validation events ────────────────────────────────

const emitter = new AgentEventEmitter();

emitter.on("output-valid", (e) => {
  console.log(`\n✓ Output valid on attempt ${e.attempt}`);
});

emitter.on("output-invalid", (e) => {
  console.warn(`\n✗ Output invalid on attempt ${e.attempt}:`);
  for (const issue of e.issues) {
    console.warn(`  - ${issue.path}: ${issue.message}`);
  }
});

emitter.on("llm-call-start", (e) => {
  console.log(`[turn ${e.turn}] → calling model...`);
});

// ── Demo 1: sentiment analysis ────────────────────────────────────────────────

console.log("=".repeat(60));
console.log("Demo 1 — Sentiment Analysis");
console.log("=".repeat(60));

const SentimentOutput = defineOutput(
  z.object({
    sentiment: z.enum(["positive", "negative", "neutral"]),
    confidence: z.number().min(0).max(1),
    summary: z.string().max(100),
    keywords: z.array(z.string()).max(5),
  }),
);

const r1 = await run(
  agent,
  "Analyse the sentiment of this review: " +
    "'The product arrived quickly and works perfectly. " +
    "Customer support was also very helpful. Highly recommend!'",
  { output: SentimentOutput, emitter },
);

// result.output is fully typed — TypeScript knows the exact shape
console.log("\nSentiment  :", r1.output?.sentiment);
console.log("Confidence :", r1.output?.confidence);
console.log("Summary    :", r1.output?.summary);
console.log("Keywords   :", r1.output?.keywords?.join(", "));

// ── Demo 2: structured data extraction ───────────────────────────────────────

console.log("\n" + "=".repeat(60));
console.log("Demo 2 — Data Extraction");
console.log("=".repeat(60));

const PersonOutput = defineOutput(
  z.object({
    name: z.string(),
    age: z.number().int().positive(),
    occupation: z.string(),
    skills: z.array(z.string()),
    yearsOfExperience: z.number().int().nonnegative(),
  }),
);

const r2 = await run(
  agent,
  "Extract the person details from this text: " +
    "'Jane Smith is a 34-year-old senior software engineer with 10 years " +
    "of experience. She specialises in TypeScript, React, and cloud architecture.'",
  { output: PersonOutput, emitter },
);

console.log("\nName        :", r2.output?.name);
console.log("Age         :", r2.output?.age);
console.log("Occupation  :", r2.output?.occupation);
console.log("Skills      :", r2.output?.skills?.join(", "));
console.log("Experience  :", r2.output?.yearsOfExperience, "years");

// ── Demo 3: classification ────────────────────────────────────────────────────

console.log("\n" + "=".repeat(60));
console.log("Demo 3 — Support Ticket Classification");
console.log("=".repeat(60));

const TicketOutput = defineOutput(
  z.object({
    category: z.enum(["billing", "technical", "account", "general"]),
    priority: z.enum(["low", "medium", "high", "urgent"]),
    requiresHuman: z.boolean(),
    suggestedResponse: z.string(),
  }),
);

const r3 = await run(
  agent,
  "Classify this support ticket: " +
    "'I cannot login to my account and I have a presentation in 2 hours. " +
    "I have tried resetting my password but the reset email never arrives.'",
  { output: TicketOutput, emitter },
);

console.log("\nCategory         :", r3.output?.category);
console.log("Priority         :", r3.output?.priority);
console.log("Requires human   :", r3.output?.requiresHuman);
console.log("Suggested reply  :", r3.output?.suggestedResponse);
