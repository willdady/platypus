import { createHash } from "node:crypto";

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

export const DEFAULT_NO_PROGRESS_THRESHOLD = 3;

const stableStringify = (value: unknown): string => {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- JSON.stringify returns undefined for a function or symbol, though typed string
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

type NoProgressTrip = { toolName: string; count: number };

type StopConditionStep = {
  toolResults?: ReadonlyArray<{
    toolName: string;
    input: unknown;
    output: unknown;
  }>;
  content?: ReadonlyArray<{
    type: string;
    approved?: boolean;
    reason?: string;
    toolCall?: { toolName: string; input: unknown };
  }>;
};

const outcomesOf = (step: StopConditionStep) => [
  ...(step.toolResults ?? []),
  ...(step.content ?? []).flatMap((part) =>
    part.type === "tool-approval-response" && !part.approved && part.toolCall
      ? [
          {
            toolName: part.toolCall.toolName,
            input: part.toolCall.input,
            output: { denied: part.reason ?? null },
          },
        ]
      : [],
  ),
];

export type NoProgressDetector = {
  stopCondition: (options: {
    steps: ReadonlyArray<StopConditionStep>;
  }) => boolean;
  tripped: () => NoProgressTrip | null;
};

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
      for (const result of outcomesOf(step)) {
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
