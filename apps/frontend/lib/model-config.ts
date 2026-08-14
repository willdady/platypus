import {
  classifyFile,
  defaultPassthroughFileTypes,
  findModelEntry,
  modelLabelFor,
  modelReferenceFor,
  resolveModelReference,
  type ConcreteModelId,
  type Provider,
} from "@platypus/schemas";

/**
 * Client-side per-model file capability helpers (issue #328). The pure logic
 * (`defaultPassthroughFileTypes`, `classifyFile`) is shared with the backend
 * via @platypus/schemas so the two never drift; this
 * module adds the frontend-only view helpers over a provider's `modelIds`,
 * which may be the new per-model objects or a legacy `string[]`.
 */

export { defaultPassthroughFileTypes };

export type ModelConfigView = {
  id: string;
  /** Bare Model alias name, when the Provider gave this model one (#386). */
  alias?: string;
  passthroughFileTypes: string[];
  /** Cap on injected extracted-document text; undefined uses the shared default. */
  maxExtractedTextChars?: number;
  /**
   * Ceiling on a single reply from this model. Undefined sends nothing and
   * leaves the provider's own default in place (issue #454).
   */
  maxOutputTokens?: number;
  /**
   * The vendor's published total token capacity, declared by an Org Admin
   * (ADR-0018). Undefined means undeclared, which is the normal state.
   */
  contextWindow?: number;
};

/** Normalize a provider's models to objects, tolerating the legacy `string[]`. */
export const getModelConfigs = (
  provider: Pick<Provider, "modelIds">,
): ModelConfigView[] =>
  (
    provider.modelIds as unknown as Array<
      string | (Partial<ModelConfigView> & { id: string })
    >
  ).map((m) =>
    typeof m === "string"
      ? { id: m, passthroughFileTypes: [] }
      : {
          id: m.id,
          alias: m.alias,
          passthroughFileTypes: m.passthroughFileTypes ?? [],
          maxExtractedTextChars: m.maxExtractedTextChars,
          maxOutputTokens: m.maxOutputTokens,
          contextWindow: m.contextWindow,
        },
  );

/**
 * One entry of a model picker. Value and label diverge for the first time with
 * Model aliases: an aliased model reads as `flagship` but submits
 * `alias:flagship`, so the two can no longer be the same string (ADR-0017).
 */
export type ModelOption = {
  value: string;
  label: string;
};

/**
 * Options for a picker whose field MAY hold an alias — the Agent and Chat model
 * selectors. The Provider's own pointer-setting inputs are free text over
 * concrete ids and deliberately do not use this.
 */
export const getModelOptions = (
  provider: Pick<Provider, "modelIds">,
): ModelOption[] =>
  getModelConfigs(provider).map((model) => ({
    value: modelReferenceFor(model),
    label: modelLabelFor(model),
  }));

/**
 * The option a stored reference selects, matched by ENTRY rather than by
 * string.
 *
 * This is what keeps aliasing an already-referenced model from silently
 * breaking the UI: a stored bare `gpt-4` still selects the entry now labelled
 * `flagship` instead of matching no option and leaving the picker showing its
 * placeholder over an Agent that is in fact configured. `undefined` means the
 * model is genuinely gone from the Provider, which behaves as it always has.
 */
export const findModelOption = (
  provider: Pick<Provider, "modelIds">,
  reference: string,
): ModelOption | undefined => {
  const entry = findModelEntry(getModelConfigs(provider), reference);
  return entry
    ? { value: modelReferenceFor(entry), label: modelLabelFor(entry) }
    : undefined;
};

/**
 * Resolve a stored reference to the concrete model it names — the frontend's
 * sole producer of `ConcreteModelId`, mirroring the backend resolver so a raw
 * `agent.modelId` cannot reach capability logic keyed on real model ids.
 */
export const resolveModelId = (
  provider: Pick<Provider, "modelIds">,
  reference: string,
): ConcreteModelId | undefined =>
  resolveModelReference(getModelConfigs(provider), reference);

/** The resolved passthrough types for a model, filling the provider default. */
export const getPassthroughFileTypes = (
  provider: Pick<Provider, "modelIds" | "providerType" | "apiMode">,
  modelId: ConcreteModelId,
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
 * The total token capacity declared for a model, or `undefined` where none was
 * declared (ADR-0018) — which is the normal state and the reason the context
 * meter has a hidden mode.
 *
 * No default to fall back to, unlike the passthrough types above: nothing can
 * discover a context window, so an undeclared one stays unknown rather than
 * being guessed at.
 */
export const getContextWindow = (
  provider: Pick<Provider, "modelIds">,
  modelId: ConcreteModelId,
): number | undefined =>
  getModelConfigs(provider).find((m) => m.id === modelId)?.contextWindow;

/**
 * Classify an attachment against a model's passthrough set — the metadata-only
 * mirror of the backend gate. `reject` means the turn would be blocked: the file
 * is neither native, text-like, nor an extractable document. `extract` (PDF /
 * DOCX, issue #342) goes through, but lossily — worth telling the user about
 * without blocking them.
 */
export const classifyAttachment = (
  file: { mediaType?: string; filename?: string },
  passthroughFileTypes: string[],
) => classifyFile(file, passthroughFileTypes);
