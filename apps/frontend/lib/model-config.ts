import {
  classifyFile,
  defaultPassthroughFileTypes,
  type Provider,
} from "@platypus/schemas";

/**
 * Client-side per-model file capability helpers (issue #328). The pure logic
 * (`defaultPassthroughFileTypes`, `mediaTypeMatches`, `isTextLikeExtension`) is
 * shared with the backend via @platypus/schemas so the two never drift; this
 * module adds the frontend-only view helpers over a provider's `modelIds`,
 * which may be the new per-model objects or a legacy `string[]`.
 */

export { defaultPassthroughFileTypes };

export type ModelConfigView = {
  id: string;
  passthroughFileTypes: string[];
};

/** Normalize a provider's models to objects, tolerating the legacy `string[]`. */
export const getModelConfigs = (
  provider: Pick<Provider, "modelIds">,
): ModelConfigView[] =>
  (
    provider.modelIds as unknown as Array<
      string | { id: string; passthroughFileTypes?: string[] }
    >
  ).map((m) =>
    typeof m === "string"
      ? { id: m, passthroughFileTypes: [] }
      : { id: m.id, passthroughFileTypes: m.passthroughFileTypes ?? [] },
  );

/** The plain model-id list, order preserved. */
export const getModelIds = (provider: Pick<Provider, "modelIds">): string[] =>
  getModelConfigs(provider).map((m) => m.id);

/** The resolved passthrough types for a model, filling the provider default. */
export const getPassthroughFileTypes = (
  provider: Pick<Provider, "modelIds" | "providerType" | "apiMode">,
  modelId: string,
): string[] => {
  const model = getModelConfigs(provider).find((m) => m.id === modelId);
  const declared = model?.passthroughFileTypes ?? [];
  return declared.length > 0
    ? declared
    : defaultPassthroughFileTypes({
        providerType: provider.providerType,
        apiMode: provider.apiMode,
      });
};

/**
 * Classify an attachment against a model's passthrough set — the metadata-only
 * mirror of the backend gate. `reject` is the case worth warning about: the
 * turn would be blocked (Phase 1) because the file is neither native nor
 * text-like.
 */
export const classifyAttachment = (
  file: { mediaType?: string; filename?: string },
  passthroughFileTypes: string[],
) => classifyFile(file, passthroughFileTypes);
