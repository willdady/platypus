import {
  findModelEntry,
  REASONING_EFFORT_STEPS,
  modelLabelFor,
  providerHonoursReasoningMap,
  resolveModelReference,
  type Agent,
  type ConcreteModelId,
  type Provider,
  type ReasoningMap,
} from "@platypus/schemas";
import { getModelConfigs, getSearchCapability } from "./model-config";
import type { Serialized } from "./api-write";

const NATIVE_REASONING_CONTROLS: ReasoningMap = {
  thinking: { on: {}, off: {} },
  effort: Object.fromEntries(REASONING_EFFORT_STEPS.map((step) => [step, {}])),
};

export function reasoningControlsFor(
  provider: Pick<Provider, "providerType" | "apiMode">,
  entry: { reasoning?: ReasoningMap } | undefined,
): ReasoningMap | undefined {
  return providerHonoursReasoningMap(provider)
    ? entry?.reasoning
    : NATIVE_REASONING_CONTROLS;
}

export type ModelSelectionInput = {
  agentId?: string;
  modelId: string;
  providerId: string;
};

export type ResolvedModel = {
  label: string;
  concreteId: ConcreteModelId;
  contextWindow: number | undefined;
  maxOutputTokens: number | undefined;
  passthroughFileTypes: string[];
  canSearch: boolean;
  reasoning: ReasoningMap | undefined;
};

export function resolveModel(input: {
  providers: Serialized<Provider>[];
  agents?: Serialized<Agent>[];
  selection: ModelSelectionInput;
}): ResolvedModel | null {
  const { providers, agents = [], selection } = input;

  let provider: Serialized<Provider> | undefined;
  let modelReference: string | undefined;

  if (selection.agentId) {
    const agent = agents.find((a) => a.id === selection.agentId);
    if (!agent) return null;
    provider = providers.find((p) => p.id === agent.providerId);
    modelReference = agent.modelId;
  } else {
    provider = providers.find((p) => p.id === selection.providerId);
    modelReference = selection.modelId;
  }

  if (!provider || !modelReference) return null;

  const configs = getModelConfigs(provider);

  const concreteId = resolveModelReference(configs, modelReference);
  if (!concreteId) return null;

  const entry = findModelEntry(configs, modelReference);

  return {
    label: entry ? modelLabelFor(entry) : concreteId,
    concreteId,
    contextWindow: entry?.contextWindow,
    maxOutputTokens: entry?.maxOutputTokens,
    passthroughFileTypes: entry?.passthroughFileTypes ?? [],
    canSearch: getSearchCapability(provider),
    reasoning: reasoningControlsFor(provider, entry),
  };
}
