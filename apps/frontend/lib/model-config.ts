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
  type ReasoningMap,
} from "@platypus/schemas";

export type ModelConfigView = {
  id: string;
  alias?: string;
  passthroughFileTypes: string[];
  maxExtractedTextChars?: number;
  maxOutputTokens?: number;
  contextWindow?: number;
  reasoning?: ReasoningMap;
};

export function getModelConfigs(
  provider: Pick<Provider, "modelIds">,
): ModelConfigView[] {
  return provider.modelIds.map((m) => ({
    id: m.id,
    alias: m.alias,
    passthroughFileTypes: m.passthroughFileTypes,
    maxExtractedTextChars: m.maxExtractedTextChars,
    maxOutputTokens: m.maxOutputTokens,
    contextWindow: m.contextWindow,
    reasoning: m.reasoning,
  }));
}

export type ModelOption = {
  value: string;
  label: string;
};

export function getModelOptions(
  provider: Pick<Provider, "modelIds">,
): ModelOption[] {
  return getModelConfigs(provider).map((model) => ({
    value: modelReferenceFor(model),
    label: modelLabelFor(model),
  }));
}

export function findModelOption(
  provider: Pick<Provider, "modelIds">,
  reference: string,
): ModelOption | undefined {
  const entry = findModelEntry(getModelConfigs(provider), reference);
  return entry
    ? { value: modelReferenceFor(entry), label: modelLabelFor(entry) }
    : undefined;
}

// why: sole producer of ConcreteModelId, so a raw model id never reaches capability logic
export function resolveModelId(
  provider: Pick<Provider, "modelIds">,
  reference: string,
): ConcreteModelId | undefined {
  return resolveModelReference(getModelConfigs(provider), reference);
}

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

export function nativeFileTypeLabels(types: string[]): string[] {
  return types.map((t) => toggleLabel(t) ?? t);
}

export function splitNativeFileTypes(types: string[]): {
  toggled: string[];
  other: string[];
} {
  return {
    toggled: types.filter(isToggleValue),
    other: types.filter((t) => !isToggleValue(t)),
  };
}

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

export function getContextWindow(
  provider: Pick<Provider, "modelIds">,
  modelId: ConcreteModelId,
): number | undefined {
  return getModelConfigs(provider).find((m) => m.id === modelId)?.contextWindow;
}

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

// why: extract goes through lossily — tell the user, but never block the turn over it
export function classifyAttachment(
  file: { mediaType?: string; filename?: string },
  passthroughFileTypes: string[],
) {
  return classifyFile(file, passthroughFileTypes);
}
