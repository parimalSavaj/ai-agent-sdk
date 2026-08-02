/**
 * examples/guardrails.ts
 *
 * Phase 8 demo — input, tool, and output guardrails.
 *
 * Shows:
 *   - Input guardrail blocking empty or profane messages
 *   - Tool guardrail blocking dangerous file paths
 *   - Output guardrail stripping accidental secrets
 *   - guardrail-triggered RunEvent via AgentEventEmitter
 *   - GuardrailError caught and handled gracefully
 *
 * Build first, then run:
 *   npm run build
 *   npm run example:guardrails
 */

import { z } from "zod";
import {
  createAgent,
  defineTool,
  defineGuardrail,
  model,
  run,
  AgentEventEmitter,
  GuardrailError,
} from "../src/index.js";

// ── Tools ─────────────────────────────────────────────────────────────────────

const readFile = defineTool({
  name: "read_file",
  description: "Read the contents of a file by path.",
  parameters: z.object({
    path: z.string().describe("Absolute file path to read"),
  }),
  execute: async ({ path }) => {
    // Simulated — in a real app this would read from disk
    const files: Record<string, string> = {
      "/home/user/notes.txt": "Meeting notes: discuss Q3 targets",
      "/home/user/readme.md": "# Project\nThis is a sample project.",
    };
    return files[path] ?? `File not found: ${path}`;
  },
});

const deleteFile = defineTool({
  name: "delete_file",
  description: "Delete a file by path.",
  parameters: z.object({
    path: z.string().describe("Absolute file path to delete"),
  }),
  execute: async ({ path }) => {
    return { deleted: true, path };
  },
});

// ── Guardrails ────────────────────────────────────────────────────────────────

// 1. Input guardrail — block empty messages
const noEmptyInput = defineGuardrail({
  name: "no-empty-input",
  type: "input" as const,
  validate: (input) => {
    if (!(input as string).trim()) {
      return { blocked: true, reason: "Input cannot be empty." };
    }
    return { blocked: false };
  },
});

// 2. Input guardrail — block messages containing banned words
const noProfanity = defineGuardrail({
  name: "no-profanity",
  type: "input" as const,
  validate: (input) => {
    const banned = ["badword", "offensive"];
    const found = banned.find((w) =>
      (input as string).toLowerCase().includes(w),
    );
    if (found) {
      return { blocked: true, reason: `Banned word detected: "${found}"` };
    }
    return { blocked: false };
  },
});

// 3. Tool guardrail — prevent reading system files
const noSystemFileRead = defineGuardrail({
  name: "no-system-file-read",
  type: "tool" as const,
  toolName: "read_file",
  validate: (args) => {
    const { path } = args as { path: string };
    if (path.startsWith("/etc") || path.startsWith("/sys") || path.startsWith("/root")) {
      return { blocked: true, reason: `Reading system path "${path}" is not allowed.` };
    }
    return { blocked: false };
  },
});

// 4. Tool guardrail — prevent deleting anything outside /tmp
const safeDeleteOnly = defineGuardrail({
  name: "safe-delete-only",
  type: "tool" as const,
  toolName: "delete_file",
  validate: (args) => {
    const { path } = args as { path: string };
    if (!path.startsWith("/tmp")) {
      return {
        blocked: true,
        reason: `Deletion outside /tmp is not allowed. Path: "${path}"`,
      };
    }
    return { blocked: false };
  },
});

// 5. Output guardrail — block responses containing API key patterns
const noSecretsInOutput = defineGuardrail({
  name: "no-secrets-in-output",
  type: "output" as const,
  validate: (output) => {
    if (/sk-[a-zA-Z0-9]{20,}/.test(output as string)) {
      return { blocked: true, reason: "Potential API key detected in output." };
    }
    return { blocked: false };
  },
});

// ── Agent ─────────────────────────────────────────────────────────────────────

const agent = createAgent({
  name: "Safe File Agent",
  instructions:
    "You are a helpful file assistant. Use tools to read or delete files when asked.",
  model: model("openrouter/openai/gpt-4o-mini"),
  tools: [readFile, deleteFile],
  inputGuardrails: [noEmptyInput, noProfanity],
  toolGuardrails: [noSystemFileRead, safeDeleteOnly],
  outputGuardrails: [noSecretsInOutput],
});

// ── EventEmitter — observe guardrail events ───────────────────────────────────

const emitter = new AgentEventEmitter();

emitter.on("guardrail-triggered", (e) => {
  console.log(
    `\n🛡  Guardrail triggered: "${e.guardrailName}"` +
      ` [${e.guardrailType}] — ${e.reason}`,
  );
});

emitter.on("tool-call-start", (e) => {
  console.log(`   ⚙  ${e.toolName}(${JSON.stringify(e.args)})`);
});

emitter.on("tool-call-end", (e) => {
  console.log(`   ✓  ${e.toolName} → ${JSON.stringify(e.result)}`);
});

// ── Helper ────────────────────────────────────────────────────────────────────

async function attempt(label: string, input: string): Promise<void> {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`▶  ${label}`);
  console.log(`   Input: "${input}"`);
  try {
    const result = await run(agent, input, { emitter });
    console.log(`   Output: ${result.finalOutput}`);
  } catch (err) {
    if (err instanceof GuardrailError) {
      console.log(`   ✗ Blocked by guardrail: ${err.message}`);
    } else {
      throw err;
    }
  }
}

// ── Run demos ─────────────────────────────────────────────────────────────────

console.log("=".repeat(60));
console.log("Guardrails Demo — Phase 8");
console.log("=".repeat(60));

// Demo 1: valid input — should pass all guardrails and read the file
await attempt(
  "Valid request",
  "Please read the file /home/user/notes.txt and summarise it.",
);

// Demo 2: empty input — blocked by input guardrail
await attempt("Empty input", "");

// Demo 3: banned word — blocked by input guardrail
await attempt("Profanity check", "This is a badword test message");

// Demo 4: system file read — tool guardrail blocks the tool call
await attempt(
  "System file read attempt",
  "Read the contents of /etc/passwd",
);

// Demo 5: unsafe delete — tool guardrail blocks the delete tool
await attempt(
  "Unsafe delete attempt",
  "Please delete the file /home/user/notes.txt",
);

// Demo 6: safe delete — passes the guardrail (path starts with /tmp)
await attempt(
  "Safe delete (allowed)",
  "Delete the temporary file /tmp/cache.txt",
);

console.log(`\n${"=".repeat(60)}`);
console.log("Done.");
