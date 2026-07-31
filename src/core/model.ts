/**
 * model.ts
 *
 * The model() entry point and provider registry.
 *
 * Design goals:
 *  - One function covers all built-in providers via a "provider/modelId" string.
 *  - Provider adapter modules are loaded lazily — using only OpenAI never
 *    pulls in the Anthropic client.
 *  - Users can register custom providers via registerProvider().
 *  - The same custom ModelProvider object can also be passed directly to
 *    createAgent() without touching the registry at all.
 */

import type { ModelProvider, ModelOptions, ProviderFactory } from "./provider.js";

// ── Known provider id type ────────────────────────────────────────────────────
// Template-literal union catches typos at compile time while still allowing
// arbitrary strings for registered custom providers.

export type KnownProvider =
  | "openai"
  | "anthropic"
  | "openrouter"
  | "ollama"
  | "lmstudio"
  | "vllm";

export type ModelSpec = `${KnownProvider}/${string}` | string;

// ── Lazy provider registry ────────────────────────────────────────────────────
// Values are async loaders that return a ProviderFactory.
// The loader runs once; subsequent calls reuse the resolved factory.

type ProviderLoader = () => Promise<ProviderFactory>;

const loaderRegistry = new Map<string, ProviderLoader>([
  [
    "openai",
    () =>
      import("../providers/openai.js").then((m) => m.createOpenAIProvider),
  ],
  [
    "anthropic",
    () =>
      import("../providers/anthropic.js").then(
        (m) => m.createAnthropicProvider,
      ),
  ],
  [
    "openrouter",
    () =>
      import("../providers/openrouter.js").then(
        (m) => m.createOpenRouterProvider,
      ),
  ],
  [
    "ollama",
    () =>
      import("../providers/compatible.js").then((m) => m.createOllamaProvider),
  ],
  [
    "lmstudio",
    () =>
      import("../providers/compatible.js").then(
        (m) => m.createLMStudioProvider,
      ),
  ],
  [
    "vllm",
    () =>
      import("../providers/compatible.js").then((m) => m.createVLLMProvider),
  ],
]);

// Cache of already-resolved factories so each loader only runs once.
const factoryCache = new Map<string, ProviderFactory>();

// ── Custom (synchronous) provider registry ────────────────────────────────────
// registerProvider() stores factories here; these are checked first so user
// registrations can shadow built-in names if needed.

const customRegistry = new Map<string, ProviderFactory>();

// ── model() ───────────────────────────────────────────────────────────────────

/**
 * Resolve a provider/modelId string to a ModelProvider.
 *
 * The spec string is split on the FIRST "/" only, so OpenRouter model ids
 * like "openrouter/anthropic/claude-3.7-sonnet" parse correctly.
 *
 * @example
 * ```ts
 * model("openai/gpt-4o-mini")
 * model("anthropic/claude-sonnet-4-5")
 * model("openrouter/anthropic/claude-3.7-sonnet")
 * model("ollama/llama3.1")
 * model("vllm/meta-llama-3-8b", { baseURL: "http://my-server:8000/v1" })
 * ```
 */
export function model(spec: ModelSpec, options?: ModelOptions): ModelProvider {
  const slashIdx = spec.indexOf("/");
  if (slashIdx === -1) {
    throw new Error(
      `Invalid model spec "${spec}". Expected format: "provider/modelId".`,
    );
  }

  const providerId = spec.slice(0, slashIdx);
  const modelId = spec.slice(slashIdx + 1);

  // Return a lazy proxy — the real adapter is loaded only when generate() or
  // stream() is first called, keeping unused vendor SDKs out of the bundle.
  return createLazyProvider(providerId, modelId, options);
}

// ── registerProvider() ────────────────────────────────────────────────────────

/**
 * Register a custom provider factory so it can be reached via the
 * model("name/modelId") string form.
 *
 * @example
 * ```ts
 * registerProvider("my-llm", (modelId, opts) => ({
 *   providerId: "my-llm",
 *   modelId,
 *   async generate(input) { ... },
 * }));
 * ```
 */
export function registerProvider(
  name: string,
  factory: ProviderFactory,
): void {
  customRegistry.set(name, factory);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Returns a ModelProvider whose generate/stream methods delegate to the real
 * adapter. The real adapter is resolved lazily on first use.
 */
function createLazyProvider(
  providerId: string,
  modelId: string,
  options?: ModelOptions,
): ModelProvider {
  let resolved: ModelProvider | null = null;

  const resolve = async (): Promise<ModelProvider> => {
    if (resolved) return resolved;

    // 1. Check custom registry first
    const customFactory = customRegistry.get(providerId);
    if (customFactory) {
      resolved = customFactory(modelId, options);
      return resolved;
    }

    // 2. Check built-in lazy loaders
    const loader = loaderRegistry.get(providerId);
    if (!loader) {
      throw new Error(
        `Unknown provider "${providerId}". ` +
          `Built-in providers: ${[...loaderRegistry.keys()].join(", ")}. ` +
          `Register a custom provider with registerProvider().`,
      );
    }

    // Cache the resolved factory
    let factory = factoryCache.get(providerId);
    if (!factory) {
      factory = await loader();
      factoryCache.set(providerId, factory);
    }

    resolved = factory(modelId, options);
    return resolved;
  };

  return {
    providerId,
    modelId,

    async generate(input) {
      const provider = await resolve();
      return provider.generate(input);
    },

    async *stream(input) {
      const provider = await resolve();
      if (!provider.stream) {
        throw new Error(
          `Provider "${providerId}" does not support streaming yet.`,
        );
      }
      yield* provider.stream(input);
    },
  };
}
