import { stepCountIs, type LanguageModel, type Tool } from "ai";
import type { NoProgressDetector } from "./no-progress.ts";

/**
 * The generation half of a resolved turn: everything the model call needs
 * except the conversation itself.
 *
 * Structurally what `ChatTurn["stream"]` carries, minus `messages` — a Chat
 * turn passes UI messages that still need converting, a delegated run passes a
 * single task prompt, and neither of those belongs in the shared assembly.
 */
export type RunPlan = {
  model: LanguageModel;
  tools: Record<string, Tool>;
  system?: string;
  maxSteps: number;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
};

/** The generation settings, minus any the plan never set. */
const declaredSettings = (plan: RunPlan): Partial<RunPlan> =>
  Object.fromEntries(
    (
      [
        // The Provider's declared ceiling for this model, absent when it
        // declares none — which is what Bedrock needs, since its Converse
        // request carries no `inferenceConfig.maxTokens` at all unless one is
        // passed (issue #454).
        "maxOutputTokens",
        "temperature",
        "topP",
        "topK",
        "frequencyPenalty",
        "presencePenalty",
        "seed",
      ] as const
    )
      .filter((key) => plan[key] !== undefined)
      .map((key) => [key, plan[key]]),
  );

/**
 * Assembles the model/tools/system/stopWhen/ceiling/sampling arguments shared
 * by every run, whichever entry point drives it.
 *
 * A parameter the plan never set is left off entirely rather than sent as
 * `undefined`. The SDK reads the two the same way, so this changes nothing it
 * receives — it means an assertion about what was sent can be written as "the
 * key is absent", which is the only form that catches a `null` or a `0` sneaking
 * in as though it were "unset".
 */
export const buildModelInvocation = (
  plan: RunPlan,
  options: {
    abortSignal: AbortSignal;
    /**
     * A stop condition beyond the step ceiling. Only unattended runs have one:
     * the no-progress detector, which halts a model re-issuing the same call
     * for the same result.
     */
    extraStopCondition?: NoProgressDetector["stopCondition"];
  },
) => ({
  model: plan.model,
  system: plan.system,
  tools: plan.tools,
  stopWhen: options.extraStopCondition
    ? [stepCountIs(plan.maxSteps), options.extraStopCondition]
    : [stepCountIs(plan.maxSteps)],
  abortSignal: options.abortSignal,
  ...declaredSettings(plan),
});
