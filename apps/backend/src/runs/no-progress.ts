import { createHash } from "node:crypto";

/**
 * Raised when an unattended run is halted for making no forward progress —
 * the model re-issued the same tool call and received the identical result
 * `threshold` times, gaining no new information each time.
 *
 * The message is machine-parseable (prefixed `no_progress:`) so a persisted
 * run record's `errorMessage` can be matched without relying on the class
 * name surviving a serialization boundary.
 */
export class NoProgressError extends Error {
  readonly reason = "no_progress" as const;
  readonly toolName: string;
  readonly count: number;

  constructor(toolName: string, count: number) {
    super(
      `no_progress: tool '${toolName}' produced the same result ${count} times without making progress`,
    );
    this.name = "NoProgressError";
    this.toolName = toolName;
    this.count = count;
  }
}

/** Repeat count that trips the detector. A call must recur (same name, args
 *  AND result) this many times within the run before the run is aborted. */
export const DEFAULT_NO_PROGRESS_THRESHOLD = 3;

/**
 * Stable JSON serialization with object keys sorted recursively, so two
 * structurally-equal values always serialize to the same string regardless
 * of key insertion order. Array order is preserved (it is significant).
 * `undefined` (e.g. an argument-less tool call) normalizes to `"null"`.
 */
const stableStringify = (value: unknown): string => {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const entries = Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${entries.join(",")}}`;
};

/**
 * Composes the full no-progress signature for one tool result: tool name +
 * normalized arguments + a hash of the result. Two invocations collide only
 * when all three match — a re-read whose result *changed* (e.g. after an
 * intervening write) hashes differently and so is NOT counted as a repeat.
 */
const signatureFor = (
  toolName: string,
  input: unknown,
  output: unknown,
): string =>
  createHash("sha1")
    .update(toolName)
    .update("\0")
    .update(stableStringify(input))
    .update("\0")
    .update(stableStringify(output))
    .digest("hex");

export type NoProgressTrip = { toolName: string; count: number };

/**
 * The slice of an AI SDK `StepResult` the detector reads. Typed structurally
 * (rather than via `StopCondition<...>`, whose generic is over the full tool
 * set) so the condition stays assignable to `stopWhen` without an `any`.
 */
type StopConditionStep = {
  toolResults?: ReadonlyArray<{
    toolName: string;
    input: unknown;
    output: unknown;
  }>;
};

export type NoProgressDetector = {
  /** Stop condition to append to `stopWhen` for unattended runs. */
  stopCondition: (options: {
    steps: ReadonlyArray<StopConditionStep>;
  }) => boolean;
  /** Non-null once the detector has tripped, naming the offending tool. */
  tripped: () => NoProgressTrip | null;
};

/**
 * Builds a run-scoped no-progress detector for an unattended run.
 *
 * The detector is strictly intra-run and lives only in memory: on each
 * stop-condition evaluation it recomputes signature counts from the steps
 * the AI SDK already accumulates for the run. No state crosses a run or
 * process boundary, so concurrent runs each hold their own detector and
 * cannot collide.
 *
 * Fail-safe direction: if a result legitimately differs every call (volatile
 * fields such as timestamps), signatures never collide, the detector simply
 * never trips, and the step ceiling remains the backstop — we under-count
 * rather than risk a false abort of a productive loop.
 */
export const createNoProgressDetector = (
  threshold: number = DEFAULT_NO_PROGRESS_THRESHOLD,
): NoProgressDetector => {
  let trip: NoProgressTrip | null = null;

  const stopCondition = ({
    steps,
  }: {
    steps: ReadonlyArray<StopConditionStep>;
  }): boolean => {
    if (trip) return true;
    const counts = new Map<string, NoProgressTrip>();
    for (const step of steps) {
      for (const result of step.toolResults ?? []) {
        const sig = signatureFor(result.toolName, result.input, result.output);
        const entry = counts.get(sig) ?? {
          toolName: result.toolName,
          count: 0,
        };
        entry.count += 1;
        counts.set(sig, entry);
        if (entry.count >= threshold) {
          trip = { toolName: entry.toolName, count: entry.count };
          return true;
        }
      }
    }
    return false;
  };

  return { stopCondition, tripped: () => trip };
};
