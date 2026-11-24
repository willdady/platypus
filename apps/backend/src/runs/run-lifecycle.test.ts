import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ABORT_GRACE_MS, startRun } from "./run-lifecycle.ts";
import { RunRegistry } from "./run-registry.ts";
import type { RunStatus } from "./types.ts";

let registry: RunRegistry;

const recordedRun = (runs: RunRegistry, runId: string) => {
  const outcomes: RunStatus[] = [];
  const run = startRun({
    runId,
    registry: runs,
    onTerminate: ({ status }) => {
      outcomes.push(status);
    },
  });
  return { run, outcomes };
};

beforeEach(() => {
  vi.useFakeTimers();
  registry = new RunRegistry();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a run whose work never unwinds", () => {
  it("still terminates as cancelled once the abort grace passes", async () => {
    const { run, outcomes } = recordedRun(registry, "lifecycle-cancel");

    expect(registry.cancel("lifecycle-cancel")).toBe(true);
    await vi.advanceTimersByTimeAsync(ABORT_GRACE_MS);

    expect(outcomes).toEqual(["cancelled"]);
    expect(run.handle.signal.aborted).toBe(true);
  });

  it("holds the runId through the grace, then releases it", async () => {
    recordedRun(registry, "lifecycle-release");

    registry.cancel("lifecycle-release");
    await vi.advanceTimersByTimeAsync(ABORT_GRACE_MS - 1);
    expect(() => recordedRun(registry, "lifecycle-release")).toThrow();

    await vi.advanceTimersByTimeAsync(1);
    expect(registry.has("lifecycle-release")).toBe(false);
    expect(() => recordedRun(registry, "lifecycle-release")).not.toThrow();
    registry.unregister("lifecycle-release");
  });

  it("terminates once, not twice, when the work unwinds afterwards", async () => {
    const { run, outcomes } = recordedRun(registry, "lifecycle-once");

    registry.cancel("lifecycle-once");
    await vi.advanceTimersByTimeAsync(ABORT_GRACE_MS);
    await run.finish("succeeded");

    expect(outcomes).toEqual(["cancelled"]);
  });
});

describe("a run whose work unwinds within the grace", () => {
  it("is finished by its own work, and frees the runId then", async () => {
    const { run, outcomes } = recordedRun(registry, "lifecycle-settle");

    registry.cancel("lifecycle-settle");
    expect(outcomes).toEqual([]);
    expect(registry.has("lifecycle-settle")).toBe(true);

    await run.finish("cancelled");
    expect(outcomes).toEqual(["cancelled"]);
    expect(registry.has("lifecycle-settle")).toBe(false);

    await vi.advanceTimersByTimeAsync(ABORT_GRACE_MS);
    expect(outcomes).toEqual(["cancelled"]);
  });
});

describe("a run stopped before its turn is adopted", () => {
  it("is finished at once, with the turn disposed first", async () => {
    const { run, outcomes } = recordedRun(registry, "lifecycle-adopt");
    const order: string[] = [];

    registry.cancel("lifecycle-adopt");
    const adopted = await run.adoptOrDispose(() => {
      order.push(`dispose (${outcomes.length} outcomes)`);
      return Promise.resolve();
    });

    expect(adopted).toBe(false);
    expect(order).toEqual(["dispose (0 outcomes)"]);
    expect(outcomes).toEqual(["cancelled"]);
    expect(registry.has("lifecycle-adopt")).toBe(false);
  });

  it("disposes a turn adopted after the run finished, and refuses it", async () => {
    const { run } = recordedRun(registry, "lifecycle-late");
    await run.finish("succeeded");
    const dispose = vi.fn(() => Promise.resolve());

    expect(await run.adoptOrDispose(dispose)).toBe(false);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe("a run stopped while the process is stopping", () => {
  it("is finished at once, without waiting out the grace", async () => {
    const { outcomes } = recordedRun(registry, "lifecycle-stopping");
    registry.beginStop();

    registry.cancel("lifecycle-stopping");
    await vi.advanceTimersByTimeAsync(0);

    expect(outcomes).toEqual(["cancelled"]);
    expect(registry.has("lifecycle-stopping")).toBe(false);
  });
});
