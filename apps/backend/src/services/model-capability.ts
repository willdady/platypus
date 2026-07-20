import {
  defaultPassthroughFileTypes,
  type ModelConfig,
  type Provider,
} from "@platypus/schemas";

// The provider-type default set is shared with the frontend via
// @platypus/schemas; re-exported so this module stays the backend's single
// capability import surface.
export { defaultPassthroughFileTypes };

/**
 * Per-model file capability resolution.
 *
 * Capability is a property of the `(provider, model)` pair and is *declared*,
 * not inferred (see issue #328). A model's `passthroughFileTypes` lists the
 * media types it ingests natively; anything else is converted to text where
 * possible (Phase 2) or, until then, cleanly rejected. This module is the
 * single source of truth for turning a provider's stored models — which may be
 * the new per-model objects OR a legacy `string[]` — into resolved
 * `ModelConfig`s with sensible provider-type defaults filled in.
 */

/**
 * Normalize a provider's stored models into resolved `ModelConfig`s.
 *
 * Tolerates both shapes so the runtime is correct regardless of migration
 * state (dev `drizzle-kit push` skips the data backfill): a bare `string`
 * entry, or an object with no `passthroughFileTypes`, inherits the
 * provider-type default. An empty list also inherits the default — this keeps a
 * newly-added model (whose types default to `[]`) from accidentally rejecting
 * every file, including images; the trade-off is that "accept nothing natively"
 * can't be expressed, which is fine (the images-only floor is already the
 * minimum, and Phase 2 extracts the rest to text).
 */
export const resolveProviderModels = (provider: Provider): ModelConfig[] => {
  const fallback = defaultPassthroughFileTypes(provider);
  const raw = provider.modelIds as unknown as Array<
    string | Partial<ModelConfig>
  >;
  return raw.map((entry) => {
    if (typeof entry === "string") {
      return { id: entry, passthroughFileTypes: fallback };
    }
    const declared = entry.passthroughFileTypes;
    return {
      id: entry.id ?? "",
      passthroughFileTypes:
        declared && declared.length > 0 ? declared : fallback,
    };
  });
};

/** The plain model-id list, preserving order — for existing `string[]` consumers. */
export const providerModelIds = (provider: Provider): string[] =>
  resolveProviderModels(provider).map((model) => model.id);

/**
 * Dedupe a provider payload's models by id (first entry wins, so an operator's
 * explicit `passthroughFileTypes` is kept over a later duplicate) and sort by
 * id for stable storage. Replaces the old `dedupeArray(modelIds).sort()` on the
 * flat string list, which no longer works now that entries are objects.
 */
export const dedupeModelConfigs = (models: ModelConfig[]): ModelConfig[] => {
  const byId = new Map<string, ModelConfig>();
  for (const model of models) {
    if (!byId.has(model.id)) byId.set(model.id, model);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
};

/** Whether `modelId` is one of the provider's enabled models. */
export const providerHasModel = (
  provider: Provider,
  modelId: string,
): boolean => resolveProviderModels(provider).some((m) => m.id === modelId);

/**
 * The media types the given model ingests natively. Falls back to the
 * provider-type default when the model isn't found (defensive — callers should
 * validate the model id first).
 */
export const passthroughFileTypesForModel = (
  provider: Provider,
  modelId: string,
): string[] => {
  const model = resolveProviderModels(provider).find((m) => m.id === modelId);
  return model
    ? model.passthroughFileTypes
    : defaultPassthroughFileTypes(provider);
};
