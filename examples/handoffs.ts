/**
 * examples/handoffs.ts
 *
 * Phase 9 demo — multi-agent handoffs.
 *
 * Shows:
 *   - A triage agent that routes to specialist agents
 *   - Context transferred automatically (full message history carries over)
 *   - handoff-start / handoff-complete events via AgentEventEmitter
 *   - result.handoffs listing every delegation that occurred
 *   - maxHandoffs loop prevention
 *
 * Build first, then run:
 *   npm run build
 *   npm run example:handoffs
 */

import { z } from "zod";
import {
  createAgent,
  defineTool,
  defineHandoff,
  model,
  run,
  AgentEventEmitter,
} from "../src/index.js";

// ── Specialist agents ─────────────────────────────────────────────────────────

// Billing agent — handles payment and invoice questions
const billingAgent = createAgent({
  name: "Billing Agent",
  instructions: [
    "You are a billing specialist. You help customers with invoices, payments,",
    "refunds, and subscription questions.",
    "Be concise and professional.",
  ].join(" "),
  model: model("openrouter/openai/gpt-4o-mini"),
});

// Technical agent — handles product and technical issues with a tool
const checkSystemStatus = defineTool({
  name: "check_system_status",
  description: "Check the current status of a service or system component.",
  parameters: z.object({
    service: z.string().describe("Service name to check"),
  }),
  execute: async ({ service }) => {
    const statuses: Record<string, string> = {
      api: "operational",
      dashboard: "degraded — 200ms latency increase",
      payments: "operational",
      auth: "operational",
    };
    return {
      service,
      status: statuses[service.toLowerCase()] ?? "operational",
      checkedAt: new Date().toISOString(),
    };
  },
});

const technicalAgent = createAgent({
  name: "Technical Agent",
  instructions: [
    "You are a technical support specialist. You help customers with product",
    "issues, bugs, and integration questions. Use check_system_status to verify",
    "if a service is experiencing issues before troubleshooting.",
  ].join(" "),
  model: model("openrouter/openai/gpt-4o-mini"),
  tools: [checkSystemStatus],
});

// Account agent — handles login, access, and account settings
const accountAgent = createAgent({
  name: "Account Agent",
  instructions: [
    "You are an account specialist. You help customers with login issues,",
    "password resets, account settings, and access permissions.",
    "Be concise and empathetic.",
  ].join(" "),
  model: model("openrouter/openai/gpt-4o-mini"),
});

// ── Triage agent — routes to the right specialist ─────────────────────────────

const handoffToBilling = defineHandoff({
  name: "handoff_to_billing",
  description:
    "Transfer to the Billing Agent for payment, invoice, refund, or subscription questions.",
  targetAgent: billingAgent,
});

const handoffToTechnical = defineHandoff({
  name: "handoff_to_technical",
  description:
    "Transfer to the Technical Agent for product bugs, service issues, or integration questions.",
  targetAgent: technicalAgent,
});

const handoffToAccount = defineHandoff({
  name: "handoff_to_account",
  description:
    "Transfer to the Account Agent for login problems, password resets, or account settings.",
  targetAgent: accountAgent,
});

const triageAgent = createAgent({
  name: "Triage Agent",
  instructions: [
    "You are a customer support triage agent. Your ONLY job is to understand",
    "what the customer needs and immediately hand off to the right specialist.",
    "Do not try to answer questions yourself — always hand off.",
    "Billing questions → handoff_to_billing.",
    "Technical/product issues → handoff_to_technical.",
    "Login/account issues → handoff_to_account.",
  ].join(" "),
  model: model("openrouter/openai/gpt-4o-mini"),
  handoffs: [handoffToBilling, handoffToTechnical, handoffToAccount],
});

// ── EventEmitter ──────────────────────────────────────────────────────────────

const emitter = new AgentEventEmitter();

emitter.on("handoff-start", (e) => {
  console.log(
    `\n🔀 Handoff #${e.handoffCount}: "${e.fromAgent}" → "${e.toAgent}"`,
  );
  console.log(`   Context: ${e.context}`);
});

emitter.on("handoff-complete", (e) => {
  console.log(`   ✓ Now with: "${e.toAgent}"`);
});

emitter.on("llm-call-start", (e) => {
  console.log(`   [${e.agentName}] turn ${e.turn} → calling model...`);
});

emitter.on("tool-call-start", (e) => {
  console.log(`   [${e.agentName}] ⚙  ${e.toolName}(${JSON.stringify(e.args)})`);
});

emitter.on("tool-call-end", (e) => {
  console.log(`   [${e.agentName}] ✓  → ${JSON.stringify(e.result)}`);
});

// ── Helper ────────────────────────────────────────────────────────────────────

async function ask(label: string, question: string): Promise<void> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`▶  ${label}`);
  console.log(`   "${question}"`);

  const result = await run(triageAgent, question, {
    emitter,
    maxHandoffs: 3,
  });

  console.log(`\n   Final answer (from ${result.handoffs.length > 0
    ? result.handoffs[result.handoffs.length - 1].toAgent
    : triageAgent.name}):`);
  console.log(`   ${result.finalOutput}`);

  if (result.handoffs.length > 0) {
    console.log(`\n   Handoff chain:`);
    for (const h of result.handoffs) {
      console.log(`     ${h.fromAgent} → ${h.toAgent}`);
    }
  }
}

// ── Demos ─────────────────────────────────────────────────────────────────────

await ask(
  "Billing question",
  "I was charged twice for my subscription this month. Can you help?",
);

await ask(
  "Technical issue",
  "The dashboard is loading slowly and some charts aren't showing. Is something wrong?",
);

await ask(
  "Account issue",
  "I can't log in to my account — the password reset email isn't arriving.",
);

console.log(`\n${"=".repeat(60)}`);
console.log("Done.");
