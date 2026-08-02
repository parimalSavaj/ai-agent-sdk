/**
 * guardrail.ts
 *
 * Guardrails — validation hooks that run at three points in the agent loop:
 *
 *   1. input   — before the first LLM call (validates the user's message)
 *   2. tool    — before a specific tool executes (validates the tool args)
 *   3. output  — before the final answer is returned (validates the response)
 *
 * Convention:
 *   - `Guardrail` uses `type` — plain data shape describing the config.
 *   - `GuardrailError` is a class — extends Error so callers can catch it
 *     specifically and inspect which guardrail triggered and why.
 *   - `defineGuardrail()` is a factory function — clean call site.
 *
 * When a guardrail blocks:
 *   - input  guardrail → throws GuardrailError immediately, run() never calls LLM
 *   - tool   guardrail → returns a structured error to the model instead of
 *                        running the tool (model can self-correct or give up)
 *   - output guardrail → throws GuardrailError before returning to the caller
 */

// ── GuardrailResult ───────────────────────────────────────────────────────────

export type GuardrailResult =
  | { blocked: false }
  | { blocked: true; reason: string };

// ── Guardrail type ────────────────────────────────────────────────────────────

export type GuardrailType = "input" | "tool" | "output";

export type Guardrail<TType extends GuardrailType = GuardrailType> = {
  /** Identifier used in logs and events */
  name: string;
  /** Where in the loop this guardrail runs */
  type: TType;
  /**
   * For tool guardrails only — if set, this guardrail only runs for the named
   * tool. If omitted, it runs for every tool call.
   */
  toolName?: TType extends "tool" ? string : never;
  /**
   * The validation function. Return `{ blocked: false }` to allow,
   * `{ blocked: true, reason: "..." }` to block.
   *
   * - input  guardrails receive the raw user input string
   * - tool   guardrails receive the parsed args object
   * - output guardrails receive the final output string
   */
  validate: (value: string | unknown) => Promise<GuardrailResult> | GuardrailResult;
};

// ── Typed helpers for each guardrail kind ─────────────────────────────────────

export type InputGuardrail = Guardrail<"input"> & {
  validate: (input: string) => Promise<GuardrailResult> | GuardrailResult;
};

export type ToolGuardrail = Guardrail<"tool"> & {
  toolName?: string;
  validate: (args: unknown) => Promise<GuardrailResult> | GuardrailResult;
};

export type OutputGuardrail = Guardrail<"output"> & {
  validate: (output: string) => Promise<GuardrailResult> | GuardrailResult;
};

// ── GuardrailError ────────────────────────────────────────────────────────────

export class GuardrailError extends Error {
  /** Name of the guardrail that triggered */
  readonly guardrailName: string;
  /** Where in the loop it triggered */
  readonly guardrailType: GuardrailType;
  /** The reason returned by the validate() function */
  readonly reason: string;

  constructor(
    guardrailName: string,
    guardrailType: GuardrailType,
    reason: string,
  ) {
    super(
      `Guardrail "${guardrailName}" (${guardrailType}) blocked the run: ${reason}`,
    );
    this.name = "GuardrailError";
    this.guardrailName = guardrailName;
    this.guardrailType = guardrailType;
    this.reason = reason;
  }
}

// ── defineGuardrail() ─────────────────────────────────────────────────────────

/**
 * Define a guardrail validation hook.
 *
 * @example
 * ```ts
 * // Input guardrail — block empty messages
 * const noEmptyInput = defineGuardrail({
 *   name: "no-empty-input",
 *   type: "input",
 *   validate: (input) => {
 *     if (!input.trim()) return { blocked: true, reason: "Input cannot be empty" };
 *     return { blocked: false };
 *   },
 * });
 *
 * // Tool guardrail — prevent deleting system files
 * const safeDelete = defineGuardrail({
 *   name: "safe-delete",
 *   type: "tool",
 *   toolName: "delete_file",
 *   validate: (args) => {
 *     const { path } = args as { path: string };
 *     if (path.startsWith("/system")) {
 *       return { blocked: true, reason: "Cannot delete system files" };
 *     }
 *     return { blocked: false };
 *   },
 * });
 *
 * // Output guardrail — remove API keys from responses
 * const noSecrets = defineGuardrail({
 *   name: "no-secrets",
 *   type: "output",
 *   validate: (output) => {
 *     if (/sk-[a-zA-Z0-9]{20,}/.test(output)) {
 *       return { blocked: true, reason: "API key detected in output" };
 *     }
 *     return { blocked: false };
 *   },
 * });
 * ```
 */
export function defineGuardrail<TType extends GuardrailType>(
  config: Guardrail<TType>,
): Guardrail<TType> {
  return config;
}

// ── Internal runner helpers ───────────────────────────────────────────────────

/**
 * Run a list of input guardrails against a user message.
 * Throws GuardrailError on the first blocked result.
 */
export async function checkInputGuardrails(
  guardrails: InputGuardrail[],
  input: string,
): Promise<void> {
  for (const g of guardrails) {
    const result = await g.validate(input);
    if (result.blocked) {
      throw new GuardrailError(g.name, "input", result.reason);
    }
  }
}

/**
 * Run tool guardrails for a specific tool call.
 * Returns a GuardrailError if blocked, null if allowed.
 * Does NOT throw — callers return the error to the model instead of crashing.
 */
export async function checkToolGuardrails(
  guardrails: ToolGuardrail[],
  toolName: string,
  args: unknown,
): Promise<GuardrailError | null> {
  const applicable = guardrails.filter(
    (g) => !g.toolName || g.toolName === toolName,
  );
  for (const g of applicable) {
    const result = await g.validate(args);
    if (result.blocked) {
      return new GuardrailError(g.name, "tool", result.reason);
    }
  }
  return null;
}

/**
 * Run output guardrails against the final model response.
 * Throws GuardrailError on the first blocked result.
 */
export async function checkOutputGuardrails(
  guardrails: OutputGuardrail[],
  output: string,
): Promise<void> {
  for (const g of guardrails) {
    const result = await g.validate(output);
    if (result.blocked) {
      throw new GuardrailError(g.name, "output", result.reason);
    }
  }
}
