import {
  providerHonoursReasoningMap,
  REASONING_EFFORT_STEPS,
  type ConcreteModelId,
  type JobSettings,
  type ReasoningChoice,
  type ReasoningEffort,
  type ReasoningFragment,
  type ReasoningMap,
} from "@platypus/schemas";
import type { JSONObject } from "@ai-sdk/provider";
import { compatProviderOptionsName } from "./provider.ts";
import {
  maxOutputTokensForModel,
  reasoningMapForModel,
} from "./model-capability.ts";
import type { ProviderRow } from "./provider-write.ts";
import {
  resolveSamplingSettings,
  type SamplingSettings,
} from "./sampling-settings.ts";

const SAMPLING_WIRE_KEYS: Record<keyof SamplingSettings, string> = {
  temperature: "temperature",
  topP: "top_p",
  topK: "top_k",
  seed: "seed",
  presencePenalty: "presence_penalty",
  frequencyPenalty: "frequency_penalty",
};

const isPlainObject = (value: unknown): value is ReasoningFragment =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const deepMerge = (
  a: ReasoningFragment,
  b: ReasoningFragment,
): ReasoningFragment => {
  const merged: ReasoningFragment = { ...a };
  for (const [key, value] of Object.entries(b)) {
    const existing = merged[key];
    merged[key] =
      isPlainObject(existing) && isPlainObject(value)
        ? deepMerge(existing, value)
        : value;
  }
  return merged;
};

export const resolveReasoning = (
  map: ReasoningMap | undefined,
  choice: ReasoningChoice,
  sampling: SamplingSettings,
): JSONObject | undefined => {
  if (!map) return undefined;

  const thinking = map.thinking
    ? (choice.reasoningThinking ?? map.default?.thinking)
    : true;
  const declaredStep = (step: ReasoningEffort | null | undefined) =>
    step ? map.effort?.[step] : undefined;

  const fragments: ReasoningFragment[] = [map.always ?? {}];
  if (map.thinking && thinking !== undefined) {
    fragments.push(thinking ? map.thinking.on : map.thinking.off);
  }
  if (thinking !== false) {
    const effort =
      declaredStep(choice.reasoningEffort) ?? declaredStep(map.default?.effort);
    if (effort) fragments.push(effort);
    if (map.budget && choice.thinkingBudget != null) {
      fragments.push({ [map.budget.field]: choice.thinkingBudget });
    }
  }

  const body = fragments.reduce(deepMerge, {});
  for (const key of Object.keys(sampling) as (keyof SamplingSettings)[]) {
    delete body[SAMPLING_WIRE_KEYS[key]];
  }
  delete body.reasoning_effort;
  return Object.keys(body).length > 0 ? (body as JSONObject) : undefined;
};

export type SdkReasoning = "none" | ReasoningEffort;

export const resolveSdkReasoning = (
  choice: ReasoningChoice,
): SdkReasoning | undefined =>
  choice.reasoningThinking === false
    ? "none"
    : (choice.reasoningEffort ?? undefined);

export type ReasoningCallSettings = {
  reasoning?: SdkReasoning;
  providerOptions?: Record<string, JSONObject>;
};

type ReasoningProvider = Pick<
  ProviderRow,
  "name" | "providerType" | "apiMode" | "modelIds"
>;

export const reasoningCallSettings = (
  provider: ReasoningProvider,
  modelId: ConcreteModelId,
  choice: ReasoningChoice,
  sampling: SamplingSettings,
): ReasoningCallSettings => {
  if (providerHonoursReasoningMap(provider)) {
    const fragment = resolveReasoning(
      reasoningMapForModel(provider, modelId),
      choice,
      sampling,
    );
    return fragment
      ? { providerOptions: { [compatProviderOptionsName(provider)]: fragment } }
      : {};
  }
  const reasoning = resolveSdkReasoning(choice);
  if (!reasoning) return {};
  if (provider.providerType === "OpenRouter") {
    const effort = reasoning === "max" ? "xhigh" : reasoning;
    return { providerOptions: { openrouter: { reasoning: { effort } } } };
  }
  return { reasoning };
};

const offeredReasoningSet = (
  provider: ReasoningProvider,
  modelId: ConcreteModelId,
  choice: ReasoningChoice,
): boolean => {
  if (!providerHonoursReasoningMap(provider)) {
    return choice.reasoningThinking != null || choice.reasoningEffort != null;
  }
  const map = reasoningMapForModel(provider, modelId);
  if (!map) return false;
  return (
    (map.thinking !== undefined && choice.reasoningThinking != null) ||
    (REASONING_EFFORT_STEPS.some((step) => map.effort?.[step]) &&
      choice.reasoningEffort != null) ||
    (map.budget !== undefined && choice.thinkingBudget != null)
  );
};

export const jobMaxOutputTokens = (
  provider: ReasoningProvider,
  modelId: ConcreteModelId,
  settings: JobSettings | null | undefined,
  cap: number,
): number => {
  const budget = settings?.thinkingBudget;
  let requestedCap = cap;
  if (budget != null && providerHonoursReasoningMap(provider)) {
    const map = reasoningMapForModel(provider, modelId);
    if (map?.budget) {
      const thinking = map.thinking
        ? (settings?.reasoningThinking ?? map.default?.thinking)
        : true;
      if (thinking !== false) requestedCap = cap + budget;
    }
  }
  const ceiling = maxOutputTokensForModel(provider, modelId);
  return ceiling === undefined ? requestedCap : Math.min(requestedCap, ceiling);
};

export const jobCallSettings = (
  provider: ReasoningProvider,
  modelId: ConcreteModelId,
  settings: JobSettings | null | undefined,
  defaults: SamplingSettings = {},
): SamplingSettings & ReasoningCallSettings => {
  const choice = settings ?? {};
  const sampling = { ...defaults, ...resolveSamplingSettings(choice) };
  return offeredReasoningSet(provider, modelId, choice)
    ? {
        ...sampling,
        ...reasoningCallSettings(provider, modelId, choice, sampling),
      }
    : sampling;
};
