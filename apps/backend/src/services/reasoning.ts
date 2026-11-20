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
import { reasoningMapForModel } from "./model-capability.ts";
import type { ProviderRow } from "./provider-write.ts";
import {
  resolveSamplingSettings,
  type SamplingSettings,
} from "./sampling-settings.ts";

/** The request-body key each SDK sampling setting goes out under. */
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

/** `b` over `a`, recursing into plain objects; anything else is replaced. */
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

/**
 * The request-body fragment a model's Reasoning map turns a turn's Reasoning
 * controls into (ADR-0040), or undefined when there is nothing to send — no
 * map, or a map whose resolution is empty — so a model without one goes out
 * byte-identical to before.
 *
 * Each control is the stored choice, else the map's default, else nothing. A
 * stored Effort step the map does not declare is never sent: it resolves as
 * though unset, leaving the stored value alone for when the model changes back.
 * Thinking off drops Effort and the budget; a map with no switch is always on.
 *
 * `sampling` is what the Agent or Chat set itself. Its keys are removed from
 * the fragment's top level, because the SDK spreads the fragment after its own
 * sampling fields and the Agent's value must win (#1521 addendum).
 */
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
  // `reasoning_effort` is the SDK's own top-level field (#1689). It is removed
  // for the same reason as the sampling keys: a fragment must not override the
  // turn's resolved Reasoning setting after the SDK has written it.
  delete body.reasoning_effort;
  // JSON by construction: every fragment was stored as JSON and parsed back.
  return Object.keys(body).length > 0 ? (body as JSONObject) : undefined;
};

/** The SDK `reasoning` call levels a turn's choice can become (#1689). */
export type SdkReasoning = "none" | ReasoningEffort;

/**
 * The SDK `reasoning` level a native Provider is sent for a turn's Reasoning
 * controls (#1689), or undefined to send none — the vendor's own default, so a
 * turn with no choice goes out byte-identical to before. Thinking off is
 * `none` whatever the step; Thinking on with no step is the vendor's default.
 * There is no map to declare a budget, and the adapters derive one from the
 * level themselves, so a stored Thinking budget is never sent.
 */
export const resolveSdkReasoning = (
  choice: ReasoningChoice,
): SdkReasoning | undefined =>
  choice.reasoningThinking === false
    ? "none"
    : (choice.reasoningEffort ?? undefined);

/** Where a turn's Reasoning controls go on the call, when anywhere. */
export type ReasoningCallSettings = {
  reasoning?: SdkReasoning;
  providerOptions?: Record<string, JSONObject>;
};

type ReasoningProvider = Pick<
  ProviderRow,
  "name" | "providerType" | "apiMode" | "modelIds"
>;

/**
 * Where a turn's Reasoning controls reach the wire, absent when there is
 * nothing to send. An OpenAI chat-mode Provider sends the Model entry's
 * Reasoning map as a body fragment (ADR-0040); every other Provider is native
 * and takes the SDK's `reasoning` level (#1689) — except OpenRouter, whose
 * adapter ignores that option and reads its own, which has no `max` step.
 */
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

/**
 * Whether `choice` sets a Reasoning control this model offers — the controls
 * the Settings dialog shows for it. A native Provider offers Thinking and
 * Effort (#1689); a Reasoning map offers what it declares (ADR-0040). Effort
 * counts wherever the control is offered, even for a step the map lacks,
 * because that step resolves to the map's default.
 */
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

/**
 * The call options one of a Provider's own jobs is sent for its Job settings
 * (ADR-0045): the job's built-in `defaults` with every sampling parameter set
 * laid over them, and the Reasoning controls resolved against the job model's
 * Reasoning map exactly as a turn's are (ADR-0040). The resolved sampling is
 * stripped from the map's fragment, so a fragment's `temperature` beats neither
 * a set value nor the job's default.
 *
 * Reasoning resolves only once a Reasoning control the model offers is set,
 * never for a block of sampling alone: the jobs sent no fragment before Job
 * settings existed, so the map's `always` and `default` fragments a turn would
 * get must not appear because someone set a Temperature — nor because of a
 * value kept from a model that offered a control this one does not, which the
 * Settings dialog no longer shows.
 */
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
