import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ABORT_GRACE_MS, startRun } from "./run-lifecycle.ts";
import { runRegistry } from "./run-registry.ts";
import type { RunStatus } from "./types.ts";

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

    expect(runRegistry.cancel("lifecycle-cancel")).toBe(true);
    await vi.advanceTimersByTimeAsync(ABORT_GRACE_MS);

    expect(outcomes).toEqual(["cancelled"]);
    expect(run.handle.signal.aborted).toBe(true);
  });

  it("holds the runId through the grace, then releases it", async () => {
    recordedRun("lifecycle-release");

    runRegistry.cancel("lifecycle-release");
    await vi.advanceTimersByTimeAsync(ABORT_GRACE_MS - 1);
    expect(() => recordedRun("lifecycle-release")).toThrow();

    await vi.advanceTimersByTimeAsync(1);
    expect(runRegistry.has("lifecycle-release")).toBe(false);
    expect(() => recordedRun("lifecycle-release")).not.toThrow();
    runRegistry.unregister("lifecycle-release");
  });

  it("terminates once, not twice, when the work unwinds afterwards", async () => {
    const { run, outcomes } = recordedRun("lifecycle-once");

    runRegistry.cancel("lifecycle-once");
    await vi.advanceTimersByTimeAsync(ABORT_GRACE_MS);
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

    await run.finish("cancelled");
    expect(outcomes).toEqual(["cancelled"]);
    expect(runRegistry.has("lifecycle-settle")).toBe(false);

    await vi.advanceTimersByTimeAsync(ABORT_GRACE_MS);
    expect(outcomes).toEqual(["cancelled"]);
  });
});

describe("a run stopped before its turn is adopted", () => {
  it("is finished at once, with the turn disposed first", async () => {
    const { run, outcomes } = recordedRun("lifecycle-adopt");
    const order: string[] = [];

    runRegistry.cancel("lifecycle-adopt");
    const adopted = await run.adoptOrDispose(() => {
      order.push(`dispose (${outcomes.length} outcomes)`);
      return Promise.resolve();
    });

    expect(adopted).toBe(false);
    expect(order).toEqual(["dispose (0 outcomes)"]);
    expect(outcomes).toEqual(["cancelled"]);
    expect(runRegistry.has("lifecycle-adopt")).toBe(false);
  });

  it("disposes a turn adopted after the run finished, and refuses it", async () => {
    const { run } = recordedRun("lifecycle-late");
    await run.finish("succeeded");
    const dispose = vi.fn(() => Promise.resolve());

    expect(await run.adoptOrDispose(dispose)).toBe(false);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe("a run stopped while the process is stopping", () => {
  afterEach(() => {
    runRegistry.resetStopStateForTests();
  });

  it("is finished at once, without waiting out the grace", async () => {
    const { outcomes } = recordedRun("lifecycle-stopping");
    runRegistry.beginStop();

    runRegistry.cancel("lifecycle-stopping");
    await vi.advanceTimersByTimeAsync(0);

    expect(outcomes).toEqual(["cancelled"]);
    expect(runRegistry.has("lifecycle-stopping")).toBe(false);
  });
});
