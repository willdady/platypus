import {
  classifyFile,
  findModelEntry,
  modelLabelFor,
  modelReferenceFor,
  providerHasNativeSearch,
  resolveModelReference,
  SEARCH_SOURCE_NATIVE,
  SEARCH_SOURCE_NONE,
  type ConcreteModelId,
  type Provider,
} from "@platypus/schemas";

/**
 * Client-side per-model file capability helpers (issue #328). The pure logic
 * (`classifyFile`) is shared with the backend
 * via @platypus/schemas so the two never drift; this
 * module adds the frontend-only view helpers over a provider's `modelIds`,
 * which may be the new per-model objects or a legacy `string[]`.
 */

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
export function getModelConfigs(
  provider: Pick<Provider, "modelIds">,
): ModelConfigView[] {
  return (
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
}

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
export function getModelOptions(
  provider: Pick<Provider, "modelIds">,
): ModelOption[] {
  return getModelConfigs(provider).map((model) => ({
    value: modelReferenceFor(model),
    label: modelLabelFor(model),
  }));
}

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
export function findModelOption(
  provider: Pick<Provider, "modelIds">,
  reference: string,
): ModelOption | undefined {
  const entry = findModelEntry(getModelConfigs(provider), reference);
  return entry
    ? { value: modelReferenceFor(entry), label: modelLabelFor(entry) }
    : undefined;
}

/**
 * Resolve a stored reference to the concrete model it names — the frontend's
 * sole producer of `ConcreteModelId`, mirroring the backend resolver so a raw
 * `agent.modelId` cannot reach capability logic keyed on real model ids.
 */
export function resolveModelId(
  provider: Pick<Provider, "modelIds">,
  reference: string,
): ConcreteModelId | undefined {
  return resolveModelReference(getModelConfigs(provider), reference);
}

/**
 * The Native file types the model dialog offers as toggles, each one exact
 * `passthroughFileTypes` value. Anything else is an "other" media type.
 */
export const NATIVE_FILE_TYPE_TOGGLES = [
  { label: "Images", value: "image/*" },
  { label: "Video", value: "video/*" },
  { label: "Audio", value: "audio/*" },
  { label: "PDF", value: "application/pdf" },
] as const;

function toggleLabel(value: string) {
  return NATIVE_FILE_TYPE_TOGGLES.find((t) => t.value === value)?.label;
}

function isToggleValue(value: string) {
  return toggleLabel(value) !== undefined;
}

/** A model's Native file types as a card shows them: toggle names, else raw. */
export function nativeFileTypeLabels(types: string[]): string[] {
  return types.map((t) => toggleLabel(t) ?? t);
}

/** Splits stored types into ticked toggle values and other media types. */
export function splitNativeFileTypes(types: string[]): {
  toggled: string[];
  other: string[];
} {
  return {
    toggled: types.filter(isToggleValue),
    other: types.filter((t) => !isToggleValue(t)),
  };
}

/**
 * The stored list from ticked toggle values plus the comma-separated "other"
 * text, in toggle order then as typed, without duplicates.
 */
export function joinNativeFileTypes(
  toggled: string[],
  otherText: string,
): string[] {
  const other = otherText
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return [
    ...new Set([
      ...NATIVE_FILE_TYPE_TOGGLES.map((t) => t.value).filter((v) =>
        toggled.includes(v),
      ),
      ...other,
    ]),
  ];
}

/**
 * The total token capacity declared for a model, or `undefined` where none was
 * declared (ADR-0018) — which is the normal state and the reason the context
 * meter has a hidden mode.
 *
 * No default to fall back to: nothing can discover a context window, so an
 * undeclared one stays unknown rather than being guessed at.
 */
export function getContextWindow(
  provider: Pick<Provider, "modelIds">,
  modelId: ConcreteModelId,
): number | undefined {
  return getModelConfigs(provider).find((m) => m.id === modelId)?.contextWindow;
}

/**
 * The output-token ceiling declared for a model, or `undefined` where the
 * Provider declares none (issue #454) — which leaves the vendor's own default
 * in force. Mirrors the backend's `maxOutputTokensForModel`.
 */
export function getMaxOutputTokens(
  provider: Pick<Provider, "modelIds">,
  modelId: ConcreteModelId,
): number | undefined {
  return getModelConfigs(provider).find((m) => m.id === modelId)
    ?.maxOutputTokens;
}

/**
 * Whether a searching turn against this Provider would actually serve search
 * tools — Provider-scoped rather than per-model, since `searchSource` is a
 * Provider setting (ADR-0014). `"none"` serves nothing; a value naming a
 * Web-search backend serves that backend regardless of native support;
 * `"native"` serves the Provider's own tool only where `providerHasNativeSearch`
 * says the (providerType, apiMode) pair actually exposes one — a Bedrock or
 * chat-completions OpenAI Provider has none, so setting `searchSource` to
 * `"native"` there resolves to no capability at all.
 */
export function getSearchCapability(
  provider: Pick<Provider, "providerType" | "apiMode" | "searchSource">,
): boolean {
  return (
    provider.searchSource !== SEARCH_SOURCE_NONE &&
    (provider.searchSource === SEARCH_SOURCE_NATIVE
      ? providerHasNativeSearch(provider)
      : Boolean(provider.searchSource))
  );
}

/**
 * Classify an attachment against a model's passthrough set — the metadata-only
 * mirror of the backend gate. `reject` means the turn would be blocked: the file
 * is neither native, text-like, nor an extractable document. `extract` (PDF /
 * DOCX, issue #342) goes through, but lossily — worth telling the user about
 * without blocking them.
 */
export function classifyAttachment(
  file: { mediaType?: string; filename?: string },
  passthroughFileTypes: string[],
) {
  return classifyFile(file, passthroughFileTypes);
}
