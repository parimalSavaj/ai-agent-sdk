/**
 * providers/openrouter.ts — Phase 3
 *
 * Stub for the OpenRouter adapter. Implemented in Phase 3.
 * Exported here so TypeScript can resolve the dynamic import in model.ts.
 */

import type { ModelProvider, ModelOptions } from "../core/provider.js";

export function createOpenRouterProvider(
  _modelId: string,
  _options?: ModelOptions,
): ModelProvider {
  throw new Error(
    "The OpenRouter provider is not implemented yet (Phase 3). " +
      "Set baseURL to https://openrouter.ai/api/v1 with your OpenRouter key.",
  );
}
