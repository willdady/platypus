import { describe, expect, it } from "vitest";
import { APICallError } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { startRun } from "./run-lifecycle.ts";
import { RunEventRecorder } from "./run-events.ts";
import {
  attemptSequence,
  fallbackFailureMessage,
  type ModelLoopOutcome,
} from "./drive.ts";
import type { RunPlan } from "./run-plan.ts";
import type { FallbackTurn } from "./types.ts";

const PRIMARY = { providerId: "p1", model: "m1" };
const FALLBACK = { providerId: "p2", model: "m2" };

const apiError = (statusCode: number, message = "provider failed") =>
  new APICallError({
    message,
    url: "https://provider.example/v1/chat",
    requestBodyValues: {},
    statusCode,
    isRetryable: statusCode === 429 || statusCode >= 500,
  });

/** A loop's outcome: clean by default, failed with `error` when given one. */
const outcomeOf = (
  opts: { error?: unknown; steps?: number } = {},
): ModelLoopOutcome => {
  const steps = Array.from({ length: opts.steps ?? 0 }, () => ({
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1 },
  }));
  return {
    truncated: false,
    stoppedAtStepLimit: false,
    text: opts.error ? "" : "answer",
    finishReason: opts.error ? undefined : "stop",
    rawFinishReason: undefined,
    steps: opts.error ? [] : steps,
    totalUsage: {},
    stepMessages: [{ role: "assistant", content: "earlier step" }],
    completedSteps: steps,
    ...(opts.error
      ? {
          failure: (opts.error as Error).message,
          failureError: opts.error,
        }
      : {}),
  };
};

const primaryPlan = (overrides: Partial<RunPlan> = {}): RunPlan => ({
  model: new MockLanguageModelV3(),
  usageModel: PRIMARY,
  tools: {},
  system: "primary prompt",
  maxSteps: 5,
  temperature: 0.2,
  ...overrides,
});

const fallbackTurn = (): FallbackTurn => ({
  plan: {
    model: new MockLanguageModelV3(),
    usageModel: FALLBACK,
    maxSteps: 50,
    temperature: 0.9,
  },
  system: "fallback prompt",
});

const sequence = (
  opts: { plan?: RunPlan; fallback?: FallbackTurn | null } = {},
) => {
  const run = startRun({
    runId: `attempts-${Math.random().toString(36).slice(2)}`,
    onTerminate: () => {},
  });
  const recorder = new RunEventRecorder({ runId: run.handle.runId });
  const attempts = attemptSequence({
    plan: opts.plan ?? primaryPlan(),
    conversation: { prompt: "hi" },
    fallback: opts.fallback === null ? undefined : fallbackTurn(),
    run,
    events: { recorder, parentEventId: null },
  });
  return { attempts, run, recorder };
};

describe("attemptSequence", () => {
  it("switches once on a Provider-unavailable failure", () => {
    const { attempts, run } = sequence();

    expect(attempts.settle(outcomeOf({ error: apiError(503) }))).toEqual({
      next: true,
    });

    const { plan, conversation } = attempts.current();
    expect(plan.usageModel).toEqual(FALLBACK);
    expect(plan.system).toBe("fallback prompt");
    expect(plan.temperature).toBe(0.9);
    expect(conversation.modelMessages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "earlier step" },
    ]);
    expect(run.stats.fallback).toEqual({ from: PRIMARY, to: FALLBACK });
  });

  it("records the switch as a model-switch Run event", () => {
    const { attempts, recorder } = sequence();
    attempts.settle(outcomeOf({ error: apiError(503, "down") }));

    expect(recorder.events).toEqual([
      expect.objectContaining({
        type: "model-switch",
        status: "completed",
        error: { message: "down", originalBytes: 4, truncated: false },
      }),
    ]);
  });

  it("never switches on an invalid-request failure", () => {
    const { attempts, run } = sequence();
    const settled = attempts.settle(outcomeOf({ error: apiError(400, "bad") }));

    expect(settled).toEqual({ next: false, failure: "bad" });
    expect(attempts.current().plan.usageModel).toEqual(PRIMARY);
    expect(run.stats.fallback).toBeUndefined();
  });

  it("never switches once the step ceiling is spent", () => {
    const { attempts } = sequence({ plan: primaryPlan({ maxSteps: 2 }) });
    const outcome = { ...outcomeOf({ error: apiError(503) }), steps: [] };
    outcome.completedSteps = outcomeOf({ steps: 2 }).completedSteps;

    expect(attempts.settle(outcome).next).toBe(false);
  });

  it("never switches twice, and composes both failures", () => {
    const { attempts } = sequence();
    attempts.settle(outcomeOf({ error: apiError(503, "primary down") }));

    const settled = attempts.settle(
      outcomeOf({ error: apiError(503, "fallback down") }),
    );

    expect(settled).toEqual({
      next: false,
      failure: fallbackFailureMessage("primary down", "fallback down"),
      modelSwitch: { from: PRIMARY, to: FALLBACK },
    });
  });

  it("settles cleanly on the fallback with the switch it made", () => {
    const { attempts } = sequence();
    attempts.settle(outcomeOf({ error: apiError(503) }));

    expect(attempts.settle(outcomeOf({ steps: 1 }))).toEqual({
      next: false,
      modelSwitch: { from: PRIMARY, to: FALLBACK },
    });
  });

  it("carries the remaining step ceiling", () => {
    const { attempts } = sequence();
    const outcome = outcomeOf({ error: apiError(503) });
    outcome.completedSteps = outcomeOf({ steps: 2 }).completedSteps;
    attempts.settle(outcome);

    expect(attempts.current().plan.maxSteps).toBe(3);
  });

  it("keeps every turn field across a switch", () => {
    const tools = {
      search: { inputSchema: {} },
    } as unknown as RunPlan["tools"];
    const turn = {
      tools,
      gateScope: { kind: "test" } as unknown as RunPlan["gateScope"],
      readOnlyToolNames: new Set(["search"]),
      initialOccupancy: 120,
      priorOccupancyReadings: [null],
      summaryId: "summary-1",
    } satisfies Partial<RunPlan>;
    const { attempts } = sequence({ plan: primaryPlan(turn) });
    attempts.settle(outcomeOf({ error: apiError(503) }));

    expect(attempts.current().plan).toMatchObject(turn);
  });

  it("allows one SDK retry only when a fallback exists", () => {
    expect(sequence().attempts.current().maxRetries).toBe(1);
    expect(
      sequence({ fallback: null }).attempts.current().maxRetries,
    ).toBeUndefined();
  });

  it("never switches without a fallback", () => {
    const { attempts } = sequence({ fallback: null });

    expect(
      attempts.settle(outcomeOf({ error: apiError(503, "down") })),
    ).toEqual({ next: false, failure: "down" });
  });
});
