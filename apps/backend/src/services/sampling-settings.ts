import type { ReasoningChoice } from "@platypus/schemas";

export type SamplingSource = {
  temperature?: number | null;
  topP?: number | null;
  topK?: number | null;
  seed?: number | null;
  presencePenalty?: number | null;
  frequencyPenalty?: number | null;
} & ReasoningChoice;

export type SamplingSettings = {
  temperature?: number;
  topP?: number;
  topK?: number;
  seed?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
};

export const resolveSamplingSettings = (
  source: SamplingSource,
): SamplingSettings => {
  const settings: SamplingSettings = {};
  if (source.temperature != null) settings.temperature = source.temperature;
  if (source.topP != null) settings.topP = source.topP;
  if (source.topK != null) settings.topK = source.topK;
  if (source.seed != null) settings.seed = source.seed;
  if (source.presencePenalty != null)
    settings.presencePenalty = source.presencePenalty;
  if (source.frequencyPenalty != null)
    settings.frequencyPenalty = source.frequencyPenalty;
  return settings;
};
