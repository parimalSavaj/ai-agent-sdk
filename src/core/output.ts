/**
 * output.ts
 *
 * Structured output — allows developers to specify a Zod schema for the
 * final model response. The runner validates the output, retries if invalid,
 * and infers TypeScript types from the schema.
 *
 * Convention:
 *   - `OutputSchema` is a class — it holds the Zod schema, the JSON schema
 *     representation, and the system prompt suffix together as a unit.
 *   - `StructuredOutputError` is a class — it extends Error so callers can
 *     catch it specifically and inspect the validation details.
 *   - `defineOutput()` is a factory function — cleaner call site than
 *     `new OutputSchema(schema)`.
 */

import { z, type ZodTypeAny } from "zod";
import { Tool } from "./tool.js";

// ── StructuredOutputError ─────────────────────────────────────────────────────

export class StructuredOutputError extends Error {
  /** The raw text the model returned that failed validation */
  readonly rawOutput: string;
  /** The Zod validation error details */
  readonly validationError: z.ZodError;
  /** How many attempts were made before giving up */
  readonly attempts: number;

  constructor(
    rawOutput: string,
    validationError: z.ZodError,
    attempts: number,
  ) {
    super(
      `Structured output validation failed after ${attempts} attempt(s): ` +
        validationError.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join(", "),
    );
    this.name = "StructuredOutputError";
    this.rawOutput = rawOutput;
    this.validationError = validationError;
    this.attempts = attempts;
  }
}

// ── OutputSchema class ────────────────────────────────────────────────────────

export class OutputSchema<TSchema extends ZodTypeAny = ZodTypeAny> {
  readonly schema: TSchema;
  /**
   * JSON schema representation — included in the system prompt so the model
   * knows exactly what shape to produce.
   */
  readonly jsonSchema: Record<string, unknown>;
  /**
   * The instruction appended to the agent's system prompt telling the model
   * to respond with valid JSON matching the schema.
   */
  readonly systemPromptSuffix: string;

  constructor(schema: TSchema) {
    this.schema = schema;
    this.jsonSchema = Tool.toJsonSchema(schema) as Record<string, unknown>;
    this.systemPromptSuffix = [
      "",
      "---",
      "IMPORTANT: You must respond with a single valid JSON object matching",
      "this exact schema — no markdown, no code fences, no explanation, just",
      "the raw JSON object:",
      "",
      JSON.stringify(this.jsonSchema, null, 2),
      "---",
    ].join("\n");
  }

  /**
   * Attempt to parse and validate a raw string from the model.
   * Returns the typed value on success, throws ZodError on failure.
   */
  parse(raw: string): z.infer<TSchema> {
    // Strip optional markdown code fences the model may add anyway
    const cleaned = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();

    const parsed = JSON.parse(cleaned);
    return this.schema.parse(parsed) as z.infer<TSchema>;
  }

  /**
   * Safe version — returns { success, data, error } instead of throwing.
   */
  safeParse(raw: string): {
    success: boolean;
    data?: z.infer<TSchema>;
    error?: z.ZodError;
    rawOutput: string;
  } {
    try {
      const data = this.parse(raw);
      return { success: true, data, rawOutput: raw };
    } catch (err) {
      if (err instanceof z.ZodError) {
        return { success: false, error: err, rawOutput: raw };
      }
      // JSON parse failure — wrap as a ZodError-like object
      const zodErr = new z.ZodError([
        {
          code: "custom",
          message: `JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
          path: [],
        },
      ]);
      return { success: false, error: zodErr, rawOutput: raw };
    }
  }
}

// ── defineOutput() ────────────────────────────────────────────────────────────

/**
 * Define a structured output schema for an agent run.
 *
 * The runner will:
 *   1. Append a JSON schema instruction to the system prompt
 *   2. Validate the model's response against the schema
 *   3. Retry (up to maxOutputRetries) if the response is invalid
 *   4. Return the typed value as `result.output`
 *
 * @example
 * ```ts
 * const SentimentOutput = defineOutput(z.object({
 *   sentiment: z.enum(["positive", "negative", "neutral"]),
 *   confidence: z.number().min(0).max(1),
 *   summary: z.string(),
 * }));
 *
 * const result = await run(agent, "Analyse this review: ...", {
 *   output: SentimentOutput,
 * });
 *
 * console.log(result.output?.sentiment); // "positive"
 * ```
 */
export function defineOutput<TSchema extends ZodTypeAny>(
  schema: TSchema,
): OutputSchema<TSchema> {
  return new OutputSchema(schema);
}
