/**
 * Context-window resolution (context-compaction-plan §A).
 *
 * Resolves the usable context window (and max output tokens) for a
 * provider+model, in this order:
 *
 *   1. Manual override     — `provider.modelMeta[modelId]`.
 *   2. API auto-detect     — Google / OpenRouter / vLLM expose the window.
 *   3. litellm registry    — community model price/context JSON (covers
 *                            OpenAI / Anthropic / Bedrock, which don't expose it).
 *   4. Conservative default — {@link DEFAULT_CONTEXT_WINDOW} (8192).
 *
 * A fall-through to the default, and every registry key MISS, is `log.warn`'d:
 * the window is then unknown and the ring must render neutral (drift T6).
 *
 * Results are cached per `providerId:modelId` with a TTL. Editing a `modelMeta`
 * override must call {@link ContextWindowResolver.evict} immediately so the
 * override takes effect without waiting for the TTL (drift T5).
 *
 * The registry lookup and HTTP probe are injected so this module is unit
 * testable without network or a vendored multi-MB JSON file (drift T4 cases are
 * exercised against small fixture registries).
 */

import { logger } from "../logger.ts";

/** Conservative window when nothing else resolves. */
export const DEFAULT_CONTEXT_WINDOW = 8192;

/** Default cache TTL: API-detected windows can drift, the override path evicts. */
export const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Short TTL for `source: "default"` resolutions (defect 6 / RV7d). A registry
 * MISS or a transient API failure falls to 8192; caching that for the full hour
 * pins a wrong window long after the blip clears. A 60 s TTL lets the next turn
 * re-probe while still collapsing a burst of same-turn lookups.
 */
export const DEFAULT_SOURCE_CACHE_TTL_MS = 60 * 1000; // 1 minute

/** Where a resolved window came from — drives ring neutrality (T6). */
export type WindowSource = "override" | "api" | "registry" | "default";

export type ResolvedWindow = {
  contextWindow: number;
  maxOutputTokens?: number;
  source: WindowSource;
};

/** The slice of a provider row this module needs. */
export type ProviderWindowInput = {
  id: string;
  providerType: string;
  baseUrl?: string | null;
  apiKey?: string | null;
  modelMeta?: Record<
    string,
    { contextWindow?: number; maxOutputTokens?: number }
  > | null;
};

/** A litellm registry entry (subset of the fields we read). */
export type RegistryEntry = {
  max_input_tokens?: number;
  max_output_tokens?: number;
  max_tokens?: number;
};

export type Registry = Record<string, RegistryEntry>;

/** Fetches and parses JSON from a URL. Injected so tests avoid network. */
export type HttpGetJson = (
  url: string,
  headers?: Record<string, string>,
) => Promise<unknown>;

export type ResolverDeps = {
  /** Provides the litellm registry (lazy; may be empty until vendored). */
  loadRegistry?: () => Promise<Registry>;
  /** model id → registry key aliases (Bedrock ARNs, Azure deployments, …). */
  aliasMap?: Record<string, string>;
  httpGetJson?: HttpGetJson;
  ttlMs?: number;
  now?: () => number;
};

// ---------------------------------------------------------------------------
// litellm registry key normalization (drift T4)
// ---------------------------------------------------------------------------

/** Strips a Bedrock ARN down to its `vendor.model` id, if it is one. */
function bedrockModelFromArn(modelId: string): string | undefined {
  const match = /foundation-model\/(.+)$/.exec(modelId);
  return match?.[1];
}

/**
 * Resolves a registry entry for a model id via the normalization chain:
 * exact → strip provider prefix → lowercase → alias map → Bedrock ARN →
 * family heuristic (longest registry key that prefixes the id) → MISS.
 */
export function lookupRegistry(
  registry: Registry,
  modelId: string,
  aliasMap: Record<string, string> = {},
): RegistryEntry | undefined {
  // 1. exact
  if (registry[modelId]) return registry[modelId];

  // 2. strip provider prefix ("openai/gpt-4o" → "gpt-4o")
  const slash = modelId.indexOf("/");
  const stripped = slash >= 0 ? modelId.slice(slash + 1) : modelId;
  if (stripped !== modelId && registry[stripped]) return registry[stripped];

  // 3. lowercase variants
  const lowerExact = modelId.toLowerCase();
  if (registry[lowerExact]) return registry[lowerExact];
  const lowerStripped = stripped.toLowerCase();
  if (registry[lowerStripped]) return registry[lowerStripped];

  // 4. alias map (Azure deployment names, custom vLLM names, …)
  const alias = aliasMap[modelId];
  if (alias && registry[alias]) return registry[alias];

  // 5. Bedrock ARN → vendor.model, tried bare and under the "bedrock/" prefix,
  // each also lowercased (registry keys for Bedrock are lowercase; ARNs are not
  // guaranteed to be — defect 11).
  const bedrock = bedrockModelFromArn(modelId);
  if (bedrock) {
    const candidates = [
      bedrock,
      `bedrock/${bedrock}`,
      bedrock.toLowerCase(),
      `bedrock/${bedrock.toLowerCase()}`,
    ];
    for (const c of candidates) if (registry[c]) return registry[c];
  }

  // 6. family heuristic — longest registry key that is a proper prefix of the
  // id, separated by "-", ".", ":", or "/" so "gpt-4" does NOT match "gpt-4.5"
  // (RV7b: raw startsWith caused gpt-4.5-preview to silently resolve via a
  // stale gpt-4 entry with a wrong 8192 window).
  // Case-insensitive so mixed-case registry keys ("Qwen/…", "meta-llama/…")
  // still match lowercase ids from providers that normalize model names.
  const strippedLower = stripped.toLowerCase();
  let best: { key: string; entry: RegistryEntry } | undefined;
  for (const key of Object.keys(registry)) {
    const keyLower = key.toLowerCase();
    const isMatch =
      strippedLower === keyLower ||
      strippedLower.startsWith(keyLower + "-") ||
      strippedLower.startsWith(keyLower + ".") ||
      strippedLower.startsWith(keyLower + ":") ||
      strippedLower.startsWith(keyLower + "/");
    if (isMatch && (!best || key.length > best.key.length)) {
      best = { key, entry: registry[key] };
    }
  }
  if (best) return best.entry;

  // 7. MISS
  return undefined;
}

function windowFromRegistryEntry(entry: RegistryEntry): {
  contextWindow?: number;
  maxOutputTokens?: number;
} {
  // Only trust the explicit input limit. litellm's `max_tokens` is the OUTPUT
  // cap (not the context window); using it would silently under-size the window
  // and cause constant over-compaction (drift F1). When `max_input_tokens` is
  // absent we return no window so the caller falls to the conservative default,
  // which at least surfaces a warn + neutral ring rather than a wrong number.
  return {
    contextWindow: entry.max_input_tokens,
    maxOutputTokens: entry.max_output_tokens,
  };
}

// ---------------------------------------------------------------------------
// API auto-detect parsers
// ---------------------------------------------------------------------------

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

async function detectGoogle(
  provider: ProviderWindowInput,
  modelId: string,
  httpGetJson: HttpGetJson,
): Promise<Partial<ResolvedWindow> | undefined> {
  const base = trimSlash(
    provider.baseUrl || "https://generativelanguage.googleapis.com",
  );
  const headers = provider.apiKey
    ? { "x-goog-api-key": provider.apiKey }
    : undefined;
  const body = (await httpGetJson(
    `${base}/v1beta/models/${modelId}`,
    headers,
  )) as {
    inputTokenLimit?: number;
    outputTokenLimit?: number;
  };
  if (typeof body?.inputTokenLimit === "number") {
    return {
      contextWindow: body.inputTokenLimit,
      maxOutputTokens: body.outputTokenLimit,
      source: "api",
    };
  }
  return undefined;
}

async function detectOpenRouter(
  provider: ProviderWindowInput,
  modelId: string,
  httpGetJson: HttpGetJson,
): Promise<Partial<ResolvedWindow> | undefined> {
  const base = trimSlash(provider.baseUrl || "https://openrouter.ai");
  const body = (await httpGetJson(`${base}/api/v1/models`)) as {
    data?: Array<{
      id?: string;
      context_length?: number;
      top_provider?: { max_completion_tokens?: number };
    }>;
  };
  const entry = body?.data?.find((m) => m.id === modelId);
  if (entry && typeof entry.context_length === "number") {
    return {
      contextWindow: entry.context_length,
      maxOutputTokens: entry.top_provider?.max_completion_tokens,
      source: "api",
    };
  }
  return undefined;
}

async function detectOpenAiCompatible(
  provider: ProviderWindowInput,
  modelId: string,
  httpGetJson: HttpGetJson,
): Promise<Partial<ResolvedWindow> | undefined> {
  if (!provider.baseUrl) return undefined; // official OpenAI omits the field
  const base = trimSlash(provider.baseUrl);
  const headers = provider.apiKey
    ? { authorization: `Bearer ${provider.apiKey}` }
    : undefined;
  const body = (await httpGetJson(`${base}/v1/models`, headers)) as {
    data?: Array<{ id?: string; max_model_len?: number }>;
  };
  const entry = body?.data?.find((m) => m.id === modelId);
  // vLLM and most OpenAI-compatible servers expose `max_model_len`.
  if (entry && typeof entry.max_model_len === "number") {
    return { contextWindow: entry.max_model_len, source: "api" };
  }
  return undefined;
}

async function detectViaApi(
  provider: ProviderWindowInput,
  modelId: string,
  httpGetJson: HttpGetJson,
): Promise<Partial<ResolvedWindow> | undefined> {
  try {
    switch (provider.providerType) {
      case "Google":
        return await detectGoogle(provider, modelId, httpGetJson);
      case "OpenRouter":
        return await detectOpenRouter(provider, modelId, httpGetJson);
      case "OpenAI":
        return await detectOpenAiCompatible(provider, modelId, httpGetJson);
      default:
        return undefined; // Anthropic / Bedrock — no API window, use registry
    }
  } catch (error) {
    logger.warn(
      {
        error,
        providerId: provider.id,
        modelId,
        providerType: provider.providerType,
      },
      "context-window API auto-detect failed; falling through",
    );
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Resolver (cache + evict)
// ---------------------------------------------------------------------------

/** RV7d: 5 s hard cap so a hung provider endpoint never blocks turns for ~300 s. */
const API_DETECT_TIMEOUT_MS = 5000;

const defaultHttpGetJson: HttpGetJson = async (url, headers) => {
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(API_DETECT_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
};

type CacheEntry = { value: ResolvedWindow; expiresAt: number };

export class ContextWindowResolver {
  #cache = new Map<string, CacheEntry>();
  /** RV7d: single-flight — concurrent callers for the same key share one fetch. */
  #inflight = new Map<string, Promise<ResolvedWindow>>();
  #loadRegistry: () => Promise<Registry>;
  #registry: Registry | undefined;
  #aliasMap: Record<string, string>;
  #httpGetJson: HttpGetJson;
  #ttlMs: number;
  #now: () => number;

  constructor(deps: ResolverDeps = {}) {
    this.#loadRegistry = deps.loadRegistry ?? (async () => ({}));
    this.#aliasMap = deps.aliasMap ?? {};
    this.#httpGetJson = deps.httpGetJson ?? defaultHttpGetJson;
    this.#ttlMs = deps.ttlMs ?? DEFAULT_CACHE_TTL_MS;
    this.#now = deps.now ?? (() => Date.now());
  }

  /** Drops all cached windows for a provider — call on `modelMeta` edit (T5). */
  evict(providerId: string): void {
    for (const key of this.#cache.keys()) {
      if (key.startsWith(`${providerId}:`)) this.#cache.delete(key);
    }
    // Also cancel any in-flight fetch for this provider so the next call
    // re-resolves with the updated modelMeta rather than caching a stale result.
    for (const key of this.#inflight.keys()) {
      if (key.startsWith(`${providerId}:`)) this.#inflight.delete(key);
    }
  }

  async #registryEntry(modelId: string): Promise<RegistryEntry | undefined> {
    if (this.#registry === undefined) {
      // A failing loader (bad vendored JSON, fs error) must not reject the whole
      // resolution — degrade to an empty registry + warn (drift F3).
      try {
        this.#registry = await this.#loadRegistry();
      } catch (error) {
        logger.warn(
          { error },
          "litellm registry load failed; treating as empty",
        );
        this.#registry = {};
      }
    }
    return lookupRegistry(this.#registry, modelId, this.#aliasMap);
  }

  async resolve(
    provider: ProviderWindowInput,
    modelId: string,
  ): Promise<ResolvedWindow> {
    const cacheKey = `${provider.id}:${modelId}`;
    const cached = this.#cache.get(cacheKey);
    if (cached && cached.expiresAt > this.#now()) return cached.value;

    // RV7d: single-flight — reuse an in-flight promise rather than spawning a
    // second fetch for the same key (cold-cache stampede protection).
    const existing = this.#inflight.get(cacheKey);
    if (existing) return existing;

    const promise = this.#resolveUncached(provider, modelId).then((value) => {
      // Only write the cache if this promise is still the live in-flight one.
      // An evict() during the fetch deletes the inflight entry; without this
      // guard the resolving promise would repopulate the cache with the stale
      // pre-update value and defeat the eviction for a full TTL (RV7c race).
      if (this.#inflight.get(cacheKey) === promise) {
        // RV7d / defect 6: a default-source result (MISS or transient API
        // failure) gets a short TTL so a blip doesn't pin 8192 for an hour.
        const ttl =
          value.source === "default"
            ? Math.min(DEFAULT_SOURCE_CACHE_TTL_MS, this.#ttlMs)
            : this.#ttlMs;
        this.#cache.set(cacheKey, { value, expiresAt: this.#now() + ttl });
        this.#inflight.delete(cacheKey);
      }
      return value;
    });
    // Store before awaiting so concurrent callers see the same promise.
    this.#inflight.set(cacheKey, promise);
    try {
      return await promise;
    } catch (err) {
      this.#inflight.delete(cacheKey);
      throw err;
    }
  }

  async #resolveUncached(
    provider: ProviderWindowInput,
    modelId: string,
  ): Promise<ResolvedWindow> {
    // 1. Manual override
    const override = provider.modelMeta?.[modelId];
    if (override?.contextWindow) {
      return {
        contextWindow: override.contextWindow,
        maxOutputTokens: override.maxOutputTokens,
        source: "override",
      };
    }

    // 2. API auto-detect
    const api = await detectViaApi(provider, modelId, this.#httpGetJson);
    if (api?.contextWindow) {
      return {
        contextWindow: api.contextWindow,
        maxOutputTokens: override?.maxOutputTokens ?? api.maxOutputTokens,
        source: "api",
      };
    }

    // 3. litellm registry
    const entry = await this.#registryEntry(modelId);
    if (entry) {
      const { contextWindow, maxOutputTokens } = windowFromRegistryEntry(entry);
      if (contextWindow) {
        return {
          contextWindow,
          maxOutputTokens: override?.maxOutputTokens ?? maxOutputTokens,
          source: "registry",
        };
      }
    } else {
      logger.warn(
        {
          metric: "litellm.key_miss",
          providerId: provider.id,
          modelId,
          providerType: provider.providerType,
        },
        "litellm registry key MISS — falling to default window",
      );
    }

    // 4. Conservative default
    logger.warn(
      {
        metric: "context_window.fell_to_default",
        providerId: provider.id,
        modelId,
        default: DEFAULT_CONTEXT_WINDOW,
      },
      "context window unresolved — using conservative default (ring neutral)",
    );
    return {
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxOutputTokens: override?.maxOutputTokens,
      source: "default",
    };
  }
}

/** Process-wide resolver. Routes use this; tests construct their own. */
import { loadBuiltinRegistry } from "./litellm-registry.ts";
export const contextWindowResolver = new ContextWindowResolver({
  loadRegistry: loadBuiltinRegistry,
});
