import type { JSONObject } from "@ai-sdk/provider";
import {
  stepCountIs,
  wrapLanguageModel,
  type LanguageModel,
  type ModelMessage,
  type SystemModelMessage,
  type Tool,
} from "ai";
import type { NoProgressDetector } from "./no-progress.ts";
import {
  applyToolResultClearing,
  DEFAULT_CLEARING_POLICY,
} from "./tool-result-clearing.ts";
import { stepOccupancy, type UsageModel } from "./run-stats.ts";
import { toolGateOptions, type ToolGateScope } from "../tool-gates/index.ts";
import { capToolResults } from "../services/tool-result.ts";
import type { OverflowRecovery } from "./context-overflow-recovery.ts";
import { TRANSCRIPT_SUMMARY_TRIGGER } from "@platypus/schemas";
import { logger } from "../logger.ts";

/**
 * Prompt caching — one mechanism is not enough (ADR-0020 Notes, issue #682).
 *
 * Every Provider Platypus supports caches the front of a request, but three of
 * the five need it declared by us. Two vendors place their own breakpoints the
 * moment a directive is in the request; one refuses to place any itself. So the
 * declaration has to be split across two seams:
 *
 * - Anthropic and OpenRouter accept a **request-level** directive and decide
 *   for themselves what to cache (automatic mode). OpenRouter routes to
 *   Anthropic models, which is why its namespace carries the same ephemeral
 *   directive. They are applied on every call via `providerOptions`.
 *
 * - Bedrock has **no automatic mode** — a consecutive cache hit exists only
 *   where it is told to put a `cachePoint`. It gets one on the System prompt
 *   (the `instructions` message) and one trailing the final message (in
 *   `prepareStep`), so the point follows the conversation as it grows.
 *
 * There is deliberately no Provider-type branch anywhere: each provider package
 * reads only its own `providerOptions` namespace and ignores the others, so
 * sending all three namespaces on every request is correct rather than sloppy
 * (verified against all five Provider types with no warnings from any).
 *
 * What automatic mode costs: on Anthropic and OpenRouter the vendor decides
 * which bytes are cached, so Platypus no longer controls or observes where the
 * breakpoints sit — the cache-read token counts on a later turn are the only
 * signal left that a directive worked (not surfaced, #682's out-of-scope note).
 */
export const REQUEST_LEVEL_CACHE_DIRECTIVE = {
  anthropic: { cacheControl: { type: "ephemeral" } },
  openrouter: { cacheControl: { type: "ephemeral" } },
} as const;

/** Bedrock's breakpoint. Never request-level — see `buildModelInvocation`. */
export const BEDROCK_CACHE_POINT = {
  amazonBedrock: { cachePoint: { type: "default" } },
} as const;

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
  /**
   * The (Provider, model) pair `model` was opened from, which the run's Token
   * usage is broken down by (issue #1634). Set wherever a plan is resolved;
   * absent only in a test's hand-built plan.
   */
  usageModel?: UsageModel;
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
  /**
   * Per-Provider request options beyond the cache directives — today the
   * Reasoning map's resolved fragment under the OpenAI chat-mode Provider's
   * namespace (ADR-0040). Absent when there is nothing to send.
   */
  providerOptions?: Record<string, JSONObject>;
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
   * The id of the Transcript summary this turn's occupancy reading was taken
   * with (ADR-0041, issue #1716) — the read at the start of the turn. Absent
   * for a turn that read no summary, and for any delegated or headless run,
   * which have no Transcript to summarise. Carried to the metadata extractor
   * so the reply records which summary its reading describes.
   */
  summaryId?: string;
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
  /**
   * What this run's Tool gates are told about where a call is made (ADR-0033),
   * from the Tool session that resolved its tools. With a gate enabled, a plan
   * without one runs no tool calls.
   */
  gateScope?: ToolGateScope;
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
    /**
     * The loop's context-overflow recovery (issue #1717): wraps the model so
     * an overflow straight after a tool step is retried once. Every Drive
     * passes one; absent only where a test assembles an invocation alone.
     */
    overflowRecovery?: OverflowRecovery;
  },
) => ({
  model:
    options.overflowRecovery && typeof plan.model !== "string"
      ? wrapLanguageModel({
          model: plan.model,
          middleware: options.overflowRecovery.middleware,
        })
      : plan.model,
  // `instructions`, not the deprecated `system`: a bare string has no place to
  // hang Bedrock's cache point, and the `SystemModelMessage` form exists for
  // exactly this. When the plan carries no System prompt, no instructions
  // message is emitted rather than an empty one.
  instructions:
    plan.system === undefined
      ? undefined
      : ({
          role: "system",
          content: plan.system,
          providerOptions: BEDROCK_CACHE_POINT,
        } satisfies SystemModelMessage),
  // Every tool's result is capped here, core-built ones included: the one seam
  // every Drive passes through (issue #1618).
  tools: capToolResults(plan.tools),
  stopWhen: options.extraStopCondition
    ? [stepCountIs(plan.maxSteps), options.extraStopCondition]
    : [stepCountIs(plan.maxSteps)],
  abortSignal: options.abortSignal,
  // The request-level cache directive (automatic mode for Anthropic and
  // OpenRouter). Note what is NOT here: Bedrock's `cachePoint`. The Bedrock
  // provider destructures its known call-level keys, then spreads whatever
  // remains straight into the Converse request — a call-level `cachePoint`
  // would be forwarded as an unrecognised top-level field, where Converse
  // accepts it nowhere and quietly caches nothing. The same hazard applies to
  // the `openrouter` namespace: never put a foreign key in either. The plan's
  // own options (a Reasoning fragment) ride beside them, in their own
  // namespace, so the directives survive.
  providerOptions: withPlanProviderOptions(plan.providerOptions),
  // Tool-result clearing (ADR-0018 Notes, issue #524) and the trailing Bedrock
  // cache point both live here, mutating the same `messages` value in the same
  // callback. `prepareStep` fires before every step INCLUDING the first, and
  // its `messages` override carries forward to later steps — the one seam that
  // reaches both a within-turn blowup and, via `initialOccupancy`, a turn's
  // very first call. It never touches `onFinish`'s response messages, so what
  // a Chat persists is unaffected regardless of what this returns.
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
    // The evidence a later decision on summarising older steps rests on
    // (issue #1717): the context is near full and clearing, the cheaper
    // mechanism, has nothing left to give. A measurement, so a window is
    // required — without one there is no reading to compare.
    if (
      cleared === messages &&
      occupancy !== undefined &&
      plan.contextWindow !== undefined &&
      occupancy / plan.contextWindow >= TRANSCRIPT_SUMMARY_TRIGGER
    ) {
      logger.info(
        {
          occupancy,
          contextWindow: plan.contextWindow,
          fraction: occupancy / plan.contextWindow,
          step: steps.length,
        },
        "Context near full with nothing left to clear",
      );
    }
    // Always a `messages` override, never an empty object: Tool-result
    // clearing (above) and the trailing cache point (below) both act on this
    // array and both must survive a single pass. The cache point is attached
    // to the final message here rather than at the call level because Bedrock
    // has no automatic mode — its point must follow the end of the conversation
    // as it grows, which only this per-step seam can track.
    return { messages: withBedrockCachePoint(cleared) };
  },
  // The Tool gate (ADR-0033): absent entirely when no gate is enabled.
  ...toolGateOptions(plan.gateScope, options.abortSignal),
  ...declaredSettings(plan),
});

/**
 * The cache directives with the plan's own options merged in per namespace,
 * so a chat-mode Provider that happens to be named `anthropic` or `openrouter`
 * adds its Reasoning fragment beside `cacheControl` rather than replacing it.
 */
const withPlanProviderOptions = (
  options: RunPlan["providerOptions"],
): Record<string, JSONObject> => {
  const merged: Record<string, JSONObject> = {
    ...REQUEST_LEVEL_CACHE_DIRECTIVE,
  };
  for (const [name, value] of Object.entries(options ?? {})) {
    merged[name] = { ...merged[name], ...value };
  }
  return merged;
};

/**
 * Removes a cache point this function placed on an earlier step, leaving any
 * other `amazonBedrock` option on the message alone. A message carrying no
 * point is returned as-is rather than needlessly cloned.
 */
const withoutBedrockCachePoint = (message: ModelMessage): ModelMessage => {
  const bedrock = message.providerOptions?.amazonBedrock;
  if (bedrock?.cachePoint === undefined) return message;
  const { cachePoint: _removed, ...rest } = bedrock;
  return {
    ...message,
    providerOptions: { ...message.providerOptions, amazonBedrock: rest },
  };
};

/**
 * Moves the Bedrock cache point to the final message of `messages`, without
 * mutating the array or the messages handed in — the last message is cloned
 * and its existing `providerOptions` are merged into, not replaced. An empty
 * conversation passes through untouched.
 *
 * Moves, not merely adds: `prepareStep`'s `messages` override carries forward
 * into the next step (`stepMessages` becomes `[...override, ...response]`), so
 * the point this placed on step one's final message is still sitting there,
 * mid-conversation, when step two runs. Adding without removing accumulates one
 * point per step — and Converse caps how many checkpoints a request may carry,
 * so a long tool-using turn eventually exceeds it and the whole request fails.
 * Stripping the previous point first is what makes the trailing point actually
 * trail the conversation rather than leave a trail behind it.
 */
const withBedrockCachePoint = (messages: ModelMessage[]): ModelMessage[] => {
  const final = messages.at(-1);
  if (final === undefined) return messages;
  return [
    ...messages.slice(0, -1).map(withoutBedrockCachePoint),
    {
      ...final,
      // Merged into the namespace, not over it: this function owns the
      // `cachePoint` key and nothing else in `amazonBedrock`, which is the same
      // contract `withoutBedrockCachePoint` keeps on the way back out.
      providerOptions: {
        ...final.providerOptions,
        amazonBedrock: {
          ...final.providerOptions?.amazonBedrock,
          ...BEDROCK_CACHE_POINT.amazonBedrock,
        },
      },
    },
  ];
};
