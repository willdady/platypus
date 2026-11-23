import {
  modelReferenceFor,
  resolveExtractedTextCap,
  resolveModelReference,
  type ConcreteModelId,
  type ModelConfig,
  type ReasoningMap,
} from "@platypus/schemas";
import type { ProviderRow } from "./provider-write.ts";

type ProviderModels = Pick<ProviderRow, "modelIds">;

export const resolveProviderModels = (
  provider: ProviderModels,
): ModelConfig[] => provider.modelIds;

export const providerModelReferences = (provider: ProviderModels): string[] =>
  resolveProviderModels(provider).map(modelReferenceFor);

export const dedupeModelConfigs = (models: ModelConfig[]): ModelConfig[] => {
  const byId = new Map<string, ModelConfig>();
  for (const model of models) {
    if (!byId.has(model.id)) byId.set(model.id, model);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
};

export const resolveModelId = (
  provider: ProviderModels,
  reference: string,
): ConcreteModelId | undefined =>
  resolveModelReference(resolveProviderModels(provider), reference);

export const pointerSettingModelId = (value: string): ConcreteModelId =>
  value as ConcreteModelId;

const modelEntry = (
  provider: ProviderModels,
  modelId: ConcreteModelId,
): ModelConfig | undefined =>
  resolveProviderModels(provider).find((m) => m.id === modelId);

export const passthroughFileTypesForModel = (
  provider: ProviderModels,
  modelId: ConcreteModelId,
): string[] => modelEntry(provider, modelId)?.passthroughFileTypes ?? [];

export const maxExtractedTextCharsForModel = (
  provider: ProviderModels,
  modelId: ConcreteModelId,
): number =>
  resolveExtractedTextCap(modelEntry(provider, modelId)?.maxExtractedTextChars);

export const maxOutputTokensForModel = (
  provider: ProviderModels,
  modelId: ConcreteModelId,
): number | undefined => modelEntry(provider, modelId)?.maxOutputTokens;

export const contextWindowForModel = (
  provider: ProviderModels,
  modelId: ConcreteModelId,
): number | undefined => modelEntry(provider, modelId)?.contextWindow;

export const reasoningMapForModel = (
  provider: ProviderModels,
  modelId: ConcreteModelId,
): ReasoningMap | undefined => modelEntry(provider, modelId)?.reasoning;
