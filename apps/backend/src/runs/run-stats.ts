import type { RunStats } from "./types.ts";
import type { CachedInputTokens, ModelUsage } from "@platypus/schemas";

export const stepOccupancy = (usage?: {
  inputTokens?: number;
}): number | undefined =>
  typeof usage?.inputTokens === "number" ? usage.inputTokens : undefined;

export const pickCachedInput = (
  details: CachedInputTokens | undefined,
): CachedInputTokens => {
  const picked: CachedInputTokens = {};
  if (typeof details?.cacheReadTokens === "number") {
    picked.cacheReadTokens = details.cacheReadTokens;
  }
  if (typeof details?.cacheWriteTokens === "number") {
    picked.cacheWriteTokens = details.cacheWriteTokens;
  }
  return picked;
};

export type RunStep = {
  toolCalls?: Array<{ toolName: string }>;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    inputTokenDetails?: CachedInputTokens;
  };
  finishReason?: string;
  rawFinishReason?: string;
  content?: unknown;
};

export const accumulateStepStats = (stats: RunStats, step: RunStep): void => {
  stats.steps = (stats.steps ?? 0) + 1;
  const counts = new Map<string, number>(
    (stats.toolCalls ?? []).map((tc) => [tc.name, tc.count]),
  );
  for (const tc of step.toolCalls ?? []) {
    counts.set(tc.toolName, (counts.get(tc.toolName) ?? 0) + 1);
  }
  stats.toolCalls = Array.from(counts, ([name, count]) => ({ name, count }));
  if (step.usage) {
    stats.inputTokens =
      (stats.inputTokens ?? 0) + (step.usage.inputTokens ?? 0);
    stats.outputTokens =
      (stats.outputTokens ?? 0) + (step.usage.outputTokens ?? 0);
    const cached = pickCachedInput(step.usage.inputTokenDetails);
    if (cached.cacheReadTokens !== undefined) {
      stats.cacheReadTokens =
        (stats.cacheReadTokens ?? 0) + cached.cacheReadTokens;
    }
    if (cached.cacheWriteTokens !== undefined) {
      stats.cacheWriteTokens =
        (stats.cacheWriteTokens ?? 0) + cached.cacheWriteTokens;
    }
  }
  stats.contextOccupancy = stepOccupancy(step.usage);
};

export const computeStats = (result: {
  steps: Array<{
    toolCalls: Array<{ toolName: string }>;
    usage?: { inputTokens?: number };
  }>;
  totalUsage: {
    inputTokens?: number;
    outputTokens?: number;
    inputTokenDetails?: CachedInputTokens;
  };
}): RunStats => {
  const toolCallCounts = new Map<string, number>();
  for (const step of result.steps) {
    for (const tc of step.toolCalls) {
      toolCallCounts.set(
        tc.toolName,
        (toolCallCounts.get(tc.toolName) ?? 0) + 1,
      );
    }
  }
  const contextOccupancy = stepOccupancy(result.steps.at(-1)?.usage);
  return {
    steps: result.steps.length,
    toolCalls: Array.from(toolCallCounts, ([name, count]) => ({ name, count })),
    inputTokens: result.totalUsage.inputTokens ?? 0,
    outputTokens: result.totalUsage.outputTokens ?? 0,
    ...pickCachedInput(result.totalUsage.inputTokenDetails),
    ...(contextOccupancy === undefined ? {} : { contextOccupancy }),
  };
};

export type UsageModel = Pick<ModelUsage, "providerId" | "model">;

type TokenCounts = {
  inputTokens: number;
  outputTokens: number;
} & CachedInputTokens;

const sumOptional = (a?: number, b?: number): number | undefined =>
  a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);

const addCounts = (a: TokenCounts, b: TokenCounts): TokenCounts => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  ...pickCachedInput({
    cacheReadTokens: sumOptional(a.cacheReadTokens, b.cacheReadTokens),
    cacheWriteTokens: sumOptional(a.cacheWriteTokens, b.cacheWriteTokens),
  }),
});

const NO_TOKENS: TokenCounts = { inputTokens: 0, outputTokens: 0 };

export const sumUsage = (rows: readonly TokenCounts[]): TokenCounts =>
  rows.reduce(addCounts, NO_TOKENS);

export const mergeUsageByModel = (
  rows: readonly ModelUsage[],
): ModelUsage[] => {
  const merged = new Map<string, ModelUsage>();
  for (const row of rows) {
    const key = JSON.stringify([row.providerId, row.model]);
    const into = merged.get(key);
    merged.set(key, {
      providerId: row.providerId,
      model: row.model,
      ...addCounts(into ?? NO_TOKENS, row),
    });
  }
  return [...merged.values()];
};

export const withDelegatedUsage = (
  own: RunStats,
  model: UsageModel | undefined,
  delegated: readonly ModelUsage[],
  ownByModel?: readonly ModelUsage[],
): RunStats => {
  const ownCounts: TokenCounts = {
    inputTokens: own.inputTokens ?? 0,
    outputTokens: own.outputTokens ?? 0,
    ...pickCachedInput(own),
  };
  const ownRows =
    ownByModel && ownByModel.length > 0
      ? mergeUsageByModel(ownByModel)
      : model && own.steps
        ? [{ ...model, ...ownCounts }]
        : [];
  const usageByModel = mergeUsageByModel([...ownRows, ...delegated]);
  if (usageByModel.length === 0) return own;
  return {
    ...own,
    ...(delegated.length ? addCounts(ownCounts, sumUsage(delegated)) : {}),
    usageByModel,
  };
};
