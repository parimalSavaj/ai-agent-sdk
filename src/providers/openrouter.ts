/**
 * providers/openrouter.ts
 *
 * OpenRouter adapter.
 *
 * OpenRouter exposes an OpenAI-compatible Chat Completions endpoint, so this
 * is a thin wrapper: we reuse the exact same OpenAI adapter logic, just
 * pointed at https://openrouter.ai/api/v1 with an OpenRouter API key.
 *
 * The one gotcha: OpenRouter model ids can contain multiple slashes
 * (e.g. "anthropic/claude-3.7-sonnet"). The model() function in model.ts
 * already splits on the FIRST slash only, so by the time we receive modelId
 * here it already contains the full OpenRouter model id — we pass it through
 * as-is without any further parsing.
 *
 * Optional extra headers:
 *   - HTTP-Referer: your app URL (shown in OpenRouter dashboard)
 *   - X-Title: your app name
 * Pass them via options.headers if desired.
 */

import { createOpenAIProvider } from "./openai.js";
import type { ModelProvider, ModelOptions } from "../core/provider.js";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export function createOpenRouterProvider(
  modelId: string,
  options?: ModelOptions,
): ModelProvider {
  // Merge in the OpenRouter base URL and key, then delegate entirely to
  // the OpenAI adapter — it handles everything else identically.
  const resolvedOptions: ModelOptions = {
    ...options,
    baseURL: (options?.baseURL as string | undefined) ?? OPENROUTER_BASE_URL,
    apiKey:
      (options?.apiKey as string | undefined) ?? process.env.OPENROUTER_API_KEY,
  };

  // The OpenAI adapter sets providerId = "openai", so we override it here
  // to correctly identify this as an OpenRouter provider.
  const inner = createOpenAIProvider(modelId, resolvedOptions);

  return {
    ...inner,
    providerId: "openrouter",
    modelId,
  };
}
