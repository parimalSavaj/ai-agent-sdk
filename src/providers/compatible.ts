/**
 * providers/compatible.ts
 *
 * Shared OpenAI-compatible adapter + named wrappers for Ollama, LM Studio,
 * and vLLM.
 *
 * Ollama, LM Studio, and vLLM all speak the OpenAI Chat Completions format
 * and differ only by their base URL (and whether auth is needed). Rather than
 * three separate adapter files, one shared implementation covers all three —
 * the named exports are thin wrappers that pre-fill the base URL.
 *
 * Base URL defaults:
 *   Ollama   : http://localhost:11434/v1   (no API key required)
 *   LM Studio: http://localhost:1234/v1    (no API key required)
 *   vLLM     : none — user must provide baseURL (server-specific)
 */

import { createOpenAIProvider } from "./openai.js";
import type { ModelProvider, ModelOptions } from "../core/provider.js";

// ── Shared core ───────────────────────────────────────────────────────────────

/**
 * Generic OpenAI-compatible adapter. Pass the base URL of any server that
 * speaks the OpenAI Chat Completions format.
 *
 * @example
 * ```ts
 * const provider = openaiCompatible("llama3.1", {
 *   baseURL: "http://my-server:8000/v1",
 * });
 * ```
 */
export function openaiCompatible(
  modelId: string,
  options: ModelOptions & { baseURL: string },
): ModelProvider {
  const inner = createOpenAIProvider(modelId, {
    ...options,
    // Most local servers don't require a real API key; use a placeholder if
    // none is provided so the openai client doesn't throw.
    apiKey:
      (options.apiKey as string | undefined) ??
      process.env.OPENAI_API_KEY ??
      "local",
  });

  return {
    ...inner,
    // Keep the providerId as passed so the caller sees "ollama", "lmstudio",
    // etc. rather than "openai" in events and logs.
    providerId: options.baseURL.includes("11434")
      ? "ollama"
      : options.baseURL.includes("1234")
        ? "lmstudio"
        : "compatible",
    modelId,
  };
}

// ── Named wrappers ────────────────────────────────────────────────────────────

export function createOllamaProvider(
  modelId: string,
  options?: ModelOptions,
): ModelProvider {
  const baseURL =
    (options?.baseURL as string | undefined) ??
    process.env.OLLAMA_BASE_URL ??
    "http://localhost:11434/v1";

  const inner = createOpenAIProvider(modelId, {
    ...options,
    baseURL,
    apiKey: (options?.apiKey as string | undefined) ?? "ollama",
  });

  return { ...inner, providerId: "ollama", modelId };
}

export function createLMStudioProvider(
  modelId: string,
  options?: ModelOptions,
): ModelProvider {
  const baseURL =
    (options?.baseURL as string | undefined) ??
    process.env.LM_STUDIO_BASE_URL ??
    "http://localhost:1234/v1";

  const inner = createOpenAIProvider(modelId, {
    ...options,
    baseURL,
    apiKey: (options?.apiKey as string | undefined) ?? "lmstudio",
  });

  return { ...inner, providerId: "lmstudio", modelId };
}

export function createVLLMProvider(
  modelId: string,
  options?: ModelOptions,
): ModelProvider {
  const baseURL = options?.baseURL as string | undefined;
  if (!baseURL) {
    throw new Error(
      'vLLM provider requires a baseURL, e.g. model("vllm/my-model", { baseURL: "http://localhost:8000/v1" })',
    );
  }

  const inner = createOpenAIProvider(modelId, {
    ...options,
    baseURL,
    apiKey: (options?.apiKey as string | undefined) ?? "vllm",
  });

  return { ...inner, providerId: "vllm", modelId };
}
