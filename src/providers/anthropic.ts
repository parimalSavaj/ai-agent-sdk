/**
 * providers/anthropic.ts — Phase 3
 *
 * Stub for the Anthropic adapter. Implemented in Phase 3.
 * Exported here so TypeScript can resolve the dynamic import in model.ts.
 */

import type { ModelProvider, ModelOptions } from "../core/provider.js";

export function createAnthropicProvider(
  _modelId: string,
  _options?: ModelOptions,
): ModelProvider {
  throw new Error(
    "The Anthropic provider is not implemented yet (Phase 3). " +
      "Install @anthropic-ai/sdk when ready.",
  );
}
