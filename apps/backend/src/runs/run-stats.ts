import type { RunStats } from "./types.ts";

/**
 * Per-run statistics, folded from the SDK's step results.
 *
 * Pure arithmetic over what the vendor reported — no registry, no timers, no
 * logging — so the occupancy rules below (ADR-0018) can be read and tested
 * without a run around them.
 */

/**
 * One step's Context occupancy: the input tokens the vendor reported for it,
 * which is the whole conversation as that call sent it (ADR-0018). `undefined`
 * where the step reported none — nothing is estimated, and 0 would read as a
 * measurement of an empty context.
 */
export const stepOccupancy = (usage?: {
  inputTokens?: number;
}): number | undefined =>
  typeof usage?.inputTokens === "number" ? usage.inputTokens : undefined;

/** As much of an SDK step result as the run lifecycle reads. */
export type RunStep = {
  toolCalls?: Array<{ toolName: string }>;
  usage?: { inputTokens?: number; outputTokens?: number };
  // Both reasons, deliberately. The unified union collapses any reason the
  // provider adapter doesn't recognise into `other` — which is how Bedrock's
  // `malformed_tool_use` becomes indistinguishable from a dozen other endings.
  // The raw value is the only record of what the provider actually said
  // (issue #406).
  finishReason?: string;
  rawFinishReason?: string;
  /**
   * The step's parts, read only for the tool calls that failed. Both the
   * streaming and the unattended path record a `tool-error` here, so one
   * callback covers both — `onChunk` would cover only streaming.
   */
  content?: unknown;
};

/**
 * Folds a single step's tool calls and usage into a running `RunStats`
 * accumulator. Mutates `stats` in place, so a consumer can observe partial
 * progress without waiting for the final result.
 */
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
  }
  // REPLACED, not summed, and outside the guard above: the whole conversation
  // is in every step's input count, so the latest step is the current context
  // size while the running totals are sums of context sizes (ADR-0018). A step
  // that reports nothing — no count, or no usage object at all — clears the
  // figure rather than leaving an earlier, smaller step's standing as if it
  // were current, which is what a mid-run stats flush would otherwise publish.
  stats.contextOccupancy = stepOccupancy(step.usage);
};

/**
 * Computes per-run statistics from an AI SDK result with `steps` and
 * `totalUsage`. Works for both stream and generate paths.
 */
export const computeStats = (result: {
  steps: Array<{
    toolCalls: Array<{ toolName: string }>;
    usage?: { inputTokens?: number };
  }>;
  totalUsage: { inputTokens?: number; outputTokens?: number };
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
  // The FINAL step only. Scanning back for the most recent step that did report
  // a count would answer with a smaller, earlier context as though it were the
  // one the run ended on.
  const contextOccupancy = stepOccupancy(result.steps.at(-1)?.usage);
  return {
    steps: result.steps.length,
    toolCalls: Array.from(toolCallCounts, ([name, count]) => ({ name, count })),
    inputTokens: result.totalUsage.inputTokens ?? 0,
    outputTokens: result.totalUsage.outputTokens ?? 0,
    // Spread so a run whose Provider reported no usage stores no key at all,
    // matching the schema's optional field: absent means unknown, and 0 would
    // read as a measurement of an empty context.
    ...(contextOccupancy === undefined ? {} : { contextOccupancy }),
  };
};
