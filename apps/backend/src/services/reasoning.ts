import type {
  ReasoningChoice,
  ReasoningEffort,
  ReasoningFragment,
  ReasoningMap,
} from "@platypus/schemas";
import type { JSONObject } from "@ai-sdk/provider";
import type { SamplingSettings } from "./sampling-settings.ts";

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
  sampling: SamplingSettings = {},
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
  // JSON by construction: every fragment was stored as JSON and parsed back.
  return Object.keys(body).length > 0 ? (body as JSONObject) : undefined;
};
