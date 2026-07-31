/**
 * providers/compatible.ts — Phase 3
 *
 * Stub for the shared OpenAI-compatible adapter (Ollama, LM Studio, vLLM).
 * Implemented in Phase 3.
 * Exported here so TypeScript can resolve the dynamic imports in model.ts.
 */

import type { ModelProvider, ModelOptions } from "../core/provider.js";

function notImplemented(name: string): ModelProvider {
  throw new Error(
    `The ${name} provider is not implemented yet (Phase 3).`,
  );
}

export function createOllamaProvider(
  _modelId: string,
  _options?: ModelOptions,
): ModelProvider {
  return notImplemented("Ollama");
}

export function createLMStudioProvider(
  _modelId: string,
  _options?: ModelOptions,
): ModelProvider {
  return notImplemented("LM Studio");
}

export function createVLLMProvider(
  _modelId: string,
  _options?: ModelOptions,
): ModelProvider {
  return notImplemented("vLLM");
}
