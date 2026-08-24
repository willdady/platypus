import {
  stepCountIs,
  type LanguageModel,
  type ModelMessage,
  type Tool,
} from "ai";
import type { NoProgressDetector } from "./no-progress.ts";
import {
  applyToolResultClearing,
  DEFAULT_CLEARING_POLICY,
} from "./tool-result-clearing.ts";
import { stepOccupancy } from "./run-stats.ts";

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
  /** The Org Admin's declared Context window for this model (ADR-0018),
   *  absent where none was declared. The sole gate on Tool-result clearing —
   *  see `buildModelInvocation` below. */
  contextWindow?: number;
  /**
   * Context occupancy the turn starts at, before its own first step has
   * reported any usage — read from the Chat's last assistant message
   * (`ChatMessageMetadata.contextOccupancy`, inputTokens + outputTokens, which
   * together make the next turn's starting size derivable exactly). Absent for
   * a delegated Sub-Agent or a headless Trigger run, which start no such
   * history, and for a Chat's very first turn.
   */
  initialOccupancy?: number;
  /**
   * Names this turn's Tool session resolved to an MCP-declared `readOnlyHint`
   * (ADR-0021, issue #626) — keyed by the name a Tool enters the turn's tool
   * map under, so it agrees with `ModelMessage` tool-result parts whether or
   * not #467's namespacing has landed. The one input Tool-result clearing
   * needs beyond the core allowlist it already knows; see
   * `buildModelInvocation` below. Absent for a plan no Tool session resolved
   * (a headless Trigger run), which clears only the core allowlist.
   */
  readOnlyToolNames?: ReadonlySet<string>;
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
  // Tool-result clearing (ADR-0018 Notes, issue #524). `prepareStep` fires
  // before every step INCLUDING the first, and its `messages` override
  // carries forward to later steps — the one seam that reaches both a
  // within-turn blowup and, via `initialOccupancy`, a turn's very first call.
  // It never touches `onFinish`'s response messages, so what a Chat persists
  // is unaffected regardless of what this returns.
  prepareStep: ({
    steps,
    messages,
  }: {
    steps: Array<{ usage?: { inputTokens?: number } }>;
    messages: ModelMessage[];
  }) => {
    // The most recently completed step's occupancy IS the current context
    // size (ADR-0018: a last value, not a sum). Before any step has run,
    // fall back to the plan's `initialOccupancy` — the only reading that
    // exists yet.
    const occupancy =
      steps.length > 0
        ? stepOccupancy(steps[steps.length - 1]?.usage)
        : plan.initialOccupancy;
    const cleared = applyToolResultClearing(
      messages,
      { occupancy, contextWindow: plan.contextWindow },
      DEFAULT_CLEARING_POLICY,
      (toolName) => plan.readOnlyToolNames?.has(toolName) ?? false,
    );
    return cleared === messages ? {} : { messages: cleared };
  },
  ...declaredSettings(plan),
});
