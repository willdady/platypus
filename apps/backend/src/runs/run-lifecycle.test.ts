import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ABORT_GRACE_MS, startRun } from "./run-lifecycle.ts";
import { runRegistry } from "./run-registry.ts";
import type { RunStatus } from "./types.ts";

/**
 * A run that is stopped must reach a terminal status even when its own work
 * never unwinds.
 *
 * Nothing here drives a model: the defect Operators saw was never visible at
 * the work. A Chat stuck on `status: "running"` with a dead stop button, and
 * a Chat that answered 409 to every later turn, were both the same thing —
 * `finish` never ran, because it was waiting on work that had stopped
 * observing the signal. #921 fixed one such piece of work; this pins the
 * guarantee at the level that does not care which piece it is.
 */
const recordedRun = (runId: string) => {
  const outcomes: RunStatus[] = [];
  const run = startRun({
    runId,
    onTerminate: ({ status }) => {
      outcomes.push(status);
    },
  });
  return { run, outcomes };
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a run whose work never unwinds", () => {
  it("still terminates as cancelled once the abort grace passes", async () => {
    const { run, outcomes } = recordedRun("lifecycle-cancel");

    // Nothing ever calls `run.finish`, exactly as a tool that ignores the
    // signal leaves the drive unable to.
    expect(runRegistry.cancel("lifecycle-cancel")).toBe(true);
    await vi.advanceTimersByTimeAsync(ABORT_GRACE_MS);

    expect(outcomes).toEqual(["cancelled"]);
    expect(run.handle.signal.aborted).toBe(true);
  });

  it("holds the runId through the grace, then releases it", async () => {
    recordedRun("lifecycle-release");

    runRegistry.cancel("lifecycle-release");
    // A Chat run's id IS the chat id: a new turn here would run alongside a
    // tool from the stopped one still working on the same resources.
    await vi.advanceTimersByTimeAsync(ABORT_GRACE_MS - 1);
    expect(() => recordedRun("lifecycle-release")).toThrow();

    // An entry left behind past the cap is what made deleting the Chat the
    // only way to use it again (#937).
    await vi.advanceTimersByTimeAsync(1);
    expect(runRegistry.has("lifecycle-release")).toBe(false);
    expect(() => recordedRun("lifecycle-release")).not.toThrow();
    runRegistry.unregister("lifecycle-release");
  });

  it("terminates once, not twice, when the work unwinds afterwards", async () => {
    const { run, outcomes } = recordedRun("lifecycle-once");

    runRegistry.cancel("lifecycle-once");
    await vi.advanceTimersByTimeAsync(ABORT_GRACE_MS);
    // The drive draining late: its own terminal call must be the no-op.
    await run.finish("succeeded");

    expect(outcomes).toEqual(["cancelled"]);
  });
});

describe("a run whose work unwinds within the grace", () => {
  it("is finished by its own work, and frees the runId then", async () => {
    const { run, outcomes } = recordedRun("lifecycle-settle");

    runRegistry.cancel("lifecycle-settle");
    expect(outcomes).toEqual([]);
    expect(runRegistry.has("lifecycle-settle")).toBe(true);

    // The drive unwinds and finishes with its own final state.
    await run.finish("cancelled");
    expect(outcomes).toEqual(["cancelled"]);
    expect(runRegistry.has("lifecycle-settle")).toBe(false);

    // The grace timer was cleared with it: nothing fires later.
    await vi.advanceTimersByTimeAsync(ABORT_GRACE_MS);
    expect(outcomes).toEqual(["cancelled"]);
  });
});

describe("a run stopped before its turn is adopted", () => {
  it("is finished at once, with the turn disposed first", async () => {
    const { run, outcomes } = recordedRun("lifecycle-adopt");
    const order: string[] = [];

    runRegistry.cancel("lifecycle-adopt");
    // No drive exists to unwind, so waiting out the grace would gain nothing.
    const adopted = await run.adoptOrDispose(() => {
      order.push(`dispose (${outcomes.length} outcomes)`);
      return Promise.resolve();
    });

    expect(adopted).toBe(false);
    expect(order).toEqual(["dispose (0 outcomes)"]);
    expect(outcomes).toEqual(["cancelled"]);
    expect(runRegistry.has("lifecycle-adopt")).toBe(false);
  });
});
