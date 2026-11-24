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
import { applyToolInputClearing } from "./tool-input-clearing.ts";
import { withAnswerStepInstruction } from "./answer-step.ts";
import { stepOccupancy, type UsageModel } from "./run-stats.ts";
import {
  toolGateOptions,
  wrapToolsWithToolResultGate,
  type ToolGateScope,
} from "../tool-gates/index.ts";
import { capToolResults } from "../services/tool-result.ts";
import type { OverflowRecovery } from "./context-overflow-recovery.ts";
import {
  TRANSCRIPT_SUMMARY_TRIGGER,
  type ContextOccupancyReading,
} from "@platypus/schemas";
import type { SdkReasoning } from "../services/reasoning.ts";
import { logger } from "../logger.ts";

export const REQUEST_LEVEL_CACHE_DIRECTIVE = {
  anthropic: { cacheControl: { type: "ephemeral" } },
  openrouter: { cacheControl: { type: "ephemeral" } },
} as const;

export const BEDROCK_CACHE_POINT = {
  amazonBedrock: { cachePoint: { type: "default" } },
} as const;

export type RunPlan = {
  model: LanguageModel;
  usageModel: UsageModel;
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
  reasoning?: SdkReasoning;
  providerOptions?: Record<string, JSONObject>;
  contextWindow?: number;
  initialOccupancy?: number;
  priorOccupancyReadings?: readonly (ContextOccupancyReading | null)[];
  summaryId?: string;
  readOnlyToolNames?: ReadonlySet<string>;
  gateScope?: ToolGateScope;
};

export const TURN_FIELDS = {
  tools: true,
  gateScope: true,
  readOnlyToolNames: true,
  initialOccupancy: true,
  priorOccupancyReadings: true,
  summaryId: true,
} as const satisfies Partial<Record<keyof RunPlan, true>>;
type TurnField = keyof typeof TURN_FIELDS;

export const GENERATION_FIELDS = {
  model: true,
  usageModel: true,
  system: true,
  maxSteps: true,
  maxOutputTokens: true,
  temperature: true,
  topP: true,
  topK: true,
  frequencyPenalty: true,
  presencePenalty: true,
  seed: true,
  reasoning: true,
  providerOptions: true,
  contextWindow: true,
} as const satisfies Record<Exclude<keyof RunPlan, TurnField>, true>;

export type GenerationField = keyof typeof GENERATION_FIELDS;

export const pickPlanFields = <K extends keyof RunPlan>(
  from: Partial<RunPlan>,
  keys: Record<K, true>,
): Pick<RunPlan, K> =>
  Object.fromEntries(
    Object.keys(keys)
      .map((key) => [key, from[key as K]] as const)
      .filter(([, value]) => value !== undefined),
  ) as Pick<RunPlan, K>;

const declaredSettings = (plan: RunPlan): Partial<RunPlan> =>
  Object.fromEntries(
    (
      [
        "maxOutputTokens",
        "temperature",
        "topP",
        "topK",
        "frequencyPenalty",
        "presencePenalty",
        "seed",
        "reasoning",
      ] as const
    )
      .filter((key) => plan[key] !== undefined)
      .map((key) => [key, plan[key]]),
  );

export const buildModelInvocation = (
  plan: RunPlan,
  options: {
    abortSignal: AbortSignal;
    extraStopCondition?: NoProgressDetector["stopCondition"];
    overflowRecovery: OverflowRecovery;
  },
) => ({
  model:
    typeof plan.model !== "string"
      ? wrapLanguageModel({
          model: plan.model,
          middleware: options.overflowRecovery.middleware,
        })
      : plan.model,
  instructions:
    plan.system === undefined
      ? undefined
      : ({
          role: "system",
          content: plan.system,
          providerOptions: BEDROCK_CACHE_POINT,
        } satisfies SystemModelMessage),
  tools: wrapToolsWithToolResultGate(
    capToolResults(plan.tools),
    plan.gateScope,
    options.abortSignal,
  ),
  stopWhen: options.extraStopCondition
    ? [stepCountIs(plan.maxSteps), options.extraStopCondition]
    : [stepCountIs(plan.maxSteps)],
  abortSignal: options.abortSignal,
  providerOptions: withPlanProviderOptions(plan.providerOptions),
  prepareStep: ({
    steps,
    stepNumber,
    messages,
  }: {
    steps: Array<{ usage?: { inputTokens?: number } }>;
    stepNumber: number;
    messages: ModelMessage[];
  }) => {
    const occupancy =
      steps.length > 0
        ? stepOccupancy(steps[steps.length - 1]?.usage)
        : plan.initialOccupancy;
    const reading = {
      occupancy,
      contextWindow: plan.contextWindow,
      priorReadings: plan.priorOccupancyReadings,
    };
    const cleared = applyToolInputClearing(
      applyToolResultClearing(
        messages,
        reading,
        DEFAULT_CLEARING_POLICY,
        (toolName) => plan.readOnlyToolNames?.has(toolName) ?? false,
      ),
      reading,
    );
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
    const withAnswerStep = withAnswerStepInstruction(cleared, {
      stepNumber,
      maxSteps: plan.maxSteps,
    });
    return { messages: withBedrockCachePoint(withAnswerStep) };
  },
  ...toolGateOptions(plan.gateScope, options.abortSignal),
  ...declaredSettings(plan),
});

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

const withoutBedrockCachePoint = (message: ModelMessage): ModelMessage => {
  const bedrock = message.providerOptions?.amazonBedrock;
  if (bedrock?.cachePoint === undefined) return message;
  const { cachePoint: _removed, ...rest } = bedrock;
  return {
    ...message,
    providerOptions: { ...message.providerOptions, amazonBedrock: rest },
  };
};

const withBedrockCachePoint = (messages: ModelMessage[]): ModelMessage[] => {
  const final = messages.at(-1);
  if (final === undefined) return messages;
  return [
    ...messages.slice(0, -1).map(withoutBedrockCachePoint),
    {
      ...final,
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
