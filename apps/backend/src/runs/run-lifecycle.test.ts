import { describe, it, expect } from "vitest";
import { startRun } from "./run-lifecycle.ts";
import { runRegistry } from "./run-registry.ts";
import type { RunStatus } from "./types.ts";

/** Let every pending microtask drain, so `finish` has run to the end. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

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

describe("a run whose work never unwinds", () => {
  it("still terminates as cancelled when it is stopped", async () => {
    const { run, outcomes } = recordedRun("lifecycle-cancel");

    // Nothing ever calls `run.finish`, exactly as a tool that ignores the
    // signal leaves the drive unable to.
    expect(runRegistry.cancel("lifecycle-cancel")).toBe(true);
    await settled();

    expect(outcomes).toEqual(["cancelled"]);
    expect(run.handle.signal.aborted).toBe(true);
  });

  it("releases the runId, so the Chat is not locked out of its next turn", async () => {
    recordedRun("lifecycle-release");

    runRegistry.cancel("lifecycle-release");
    await settled();

    // A Chat run's id IS the chat id. An entry left behind here is what made
    // deleting the Chat the only way to use it again.
    expect(runRegistry.has("lifecycle-release")).toBe(false);
    expect(() => recordedRun("lifecycle-release")).not.toThrow();
    runRegistry.unregister("lifecycle-release");
  });

  it("terminates once, not twice, when the work unwinds afterwards", async () => {
    const { run, outcomes } = recordedRun("lifecycle-once");

    runRegistry.cancel("lifecycle-once");
    await settled();
    // The drive draining late: its own terminal call must be the no-op.
    await run.finish("succeeded");

    expect(outcomes).toEqual(["cancelled"]);
  });
});
