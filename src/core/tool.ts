/**
 * tool.ts
 *
 * Tool definition and the defineTool() factory.
 *
 * Convention:
 *   - `Tool` is a class — it holds data AND the execute() behavior together,
 *     and is instantiated by defineTool().
 *   - `ToolDefinition` and `JsonSchema` are plain data shapes, so they use `type`.
 *
 * Zod gives us two things for free:
 *   1. Runtime validation of arguments coming back from the model.
 *   2. Compile-time inference of the execute() parameter type from the schema —
 *      no manual typing needed.
 */

import { z, type ZodTypeAny } from "zod";

// ── JSON Schema subset (enough for tool parameter descriptions) ───────────────

export type JsonSchemaType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "array"
  | "object"
  | "null";

export type JsonSchema = {
  type?: JsonSchemaType | JsonSchemaType[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  [key: string]: unknown;
};

// ── ToolDefinition — the input shape passed to defineTool() ──────────────────

export type ToolDefinition<TSchema extends ZodTypeAny> = {
  name: string;
  description: string;
  parameters: TSchema;
  execute: (args: z.infer<TSchema>) => Promise<unknown>;
};

// ── Tool class ────────────────────────────────────────────────────────────────
// A class here makes sense: it bundles the schema, the JSON schema (computed
// once at construction), and the execute behavior into a single cohesive unit.

export class Tool<TSchema extends ZodTypeAny = ZodTypeAny> {
  /** Identifier sent to the model — must be unique within an agent */
  readonly name: string;
  /** Plain-English description the model uses to decide when to call this tool */
  readonly description: string;
  /** Zod schema; used for runtime validation of args from the model */
  readonly parameters: TSchema;
  /** Pre-compiled JSON schema, generated once at construction time */
  readonly jsonSchema: JsonSchema;
  /** The function that actually runs when the model requests this tool */
  readonly execute: (args: z.infer<TSchema>) => Promise<unknown>;

  constructor(def: ToolDefinition<TSchema>) {
    this.name = def.name;
    this.description = def.description;
    this.parameters = def.parameters;
    this.execute = def.execute;
    this.jsonSchema = Tool.toJsonSchema(def.parameters);

    if (this.jsonSchema.type !== "object") {
      throw new Error(
        `Tool "${def.name}": parameters schema must be a Zod object at the top level.`,
      );
    }
  }

  // ── Zod → JSON schema conversion ───────────────────────────────────────────
  // Zod v4 changed _def: the discriminator is now _def.type ("object",
  // "string", …) instead of the old _def.typeName ("ZodObject", "ZodString", …).
  // Shape values are plain schema objects (not a factory function).
  // Arrays use _def.element (not _def.type). Enums use _def.entries (not _def.values).
  // Static so it can be tested independently.

  static toJsonSchema(schema: ZodTypeAny): JsonSchema {
    const def = schema._def as unknown as Record<string, unknown>;
    const typeName = def["type"] as string;

    switch (typeName) {
      case "string":
        return { type: "string" };
      case "number":
      case "int":
        return { type: "number" };
      case "boolean":
        return { type: "boolean" };
      case "null":
        return { type: "null" };
      case "array": {
        const items = Tool.toJsonSchema(def["element"] as ZodTypeAny);
        return { type: "array", items };
      }
      case "optional":
      case "nullable":
        return Tool.toJsonSchema(def["innerType"] as ZodTypeAny);
      case "object": {
        const shape = def["shape"] as Record<string, ZodTypeAny>;
        const properties: Record<string, JsonSchema> = {};
        const required: string[] = [];

        for (const [key, value] of Object.entries(shape)) {
          const fieldDef = (value as ZodTypeAny)._def as unknown as Record<
            string,
            unknown
          >;
          const isOptional = fieldDef["type"] === "optional";
          properties[key] = Tool.toJsonSchema(value as ZodTypeAny);
          // Copy description from .describe() if present
          const description = fieldDef["description"] as string | undefined;
          if (description) properties[key].description = description;
          if (!isOptional) required.push(key);
        }

        const result: JsonSchema = { type: "object", properties };
        if (required.length > 0) result.required = required;
        return result;
      }
      case "enum": {
        // Zod v4 stores enum values as { key: value } entries object
        const entries = def["entries"] as Record<string, unknown>;
        return { type: "string", enum: Object.values(entries) };
      }
      case "literal": {
        // Zod v4 stores literal values as an array
        const values = def["values"] as unknown[];
        const v = values[0];
        const t = typeof v as JsonSchemaType;
        return { type: t, enum: values };
      }
      default:
        // Fallback — unknown Zod type, emit an empty schema
        return {};
    }
  }
}

// ── defineTool() ──────────────────────────────────────────────────────────────
// Factory function — friendlier call site than `new Tool({...})` and matches
// the public API in the plan.

export function defineTool<TSchema extends ZodTypeAny>(
  def: ToolDefinition<TSchema>,
): Tool<TSchema> {
  return new Tool(def);
}
