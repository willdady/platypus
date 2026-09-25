import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  RunRegistry,
  TimeoutError,
  DEFAULT_PER_STEP_TIMEOUT_MS,
  DEFAULT_PER_RUN_TIMEOUT_MS,
  describeTimeout,
} from "./run-registry.ts";
import { ConflictError } from "../errors.ts";

describe("RunRegistry", () => {
  let registry: RunRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new RunRegistry();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("register returns a handle whose signal aborts on cancel", () => {
    const handle = registry.register("run-1");
    expect(handle.signal.aborted).toBe(false);

    expect(registry.cancel("run-1")).toBe(true);
    expect(handle.signal.aborted).toBe(true);
  });

  it("cancel(unknown) returns false and does not throw", () => {
    expect(registry.cancel("nope")).toBe(false);
  });

  // Issue #648. A Chat run's id IS the chat id, so a second submission into a
  // Chat with a live turn lands here — and the claim is now the first thing a
  // run does, ahead of any persistence, so this rejection is what protects the
  // live run's state. Typed as a `ConflictError` because ADR-0010's central
  // handler answers 409 for one; a plain `Error` became a 500.
  it("rejects a duplicate runId with a ConflictError", () => {
    registry.register("dup-1");

    expect(() => registry.register("dup-1")).toThrow(ConflictError);
  });

  it("frees the id for a later run once the first unregisters", () => {
    registry.register("dup-2");
    registry.unregister("dup-2");

    expect(() => registry.register("dup-2")).not.toThrow();
  });

  // The rejection must not disturb the run that holds the id: its signal and
  // its timers belong to the first claim.
  it("leaves the holding run untouched when a duplicate is rejected", () => {
    const handle = registry.register("dup-3", {
      perStepTimeoutMs: 1000,
      perRunTimeoutMs: 1_000_000,
    });

    expect(() => registry.register("dup-3")).toThrow(ConflictError);

    expect(handle.signal.aborted).toBe(false);
    expect(registry.cancel("dup-3")).toBe(true);
  });

  it("cancel is idempotent", () => {
    registry.register("run-2");
    expect(registry.cancel("run-2")).toBe(true);
    expect(registry.cancel("run-2")).toBe(false);
  });

  it("unregister prevents future cancel from doing anything", () => {
    const handle = registry.register("run-3");
    registry.unregister("run-3");
    expect(handle.signal.aborted).toBe(false);
    expect(registry.cancel("run-3")).toBe(false);
  });

  it("per-step timeout fires onTimeout with kind=step and aborts the signal", () => {
    const onTimeout = vi.fn();
    const handle = registry.register("run-4", {
      perStepTimeoutMs: 1000,
      perRunTimeoutMs: 1_000_000,
      onTimeout,
    });

    vi.advanceTimersByTime(1000);

    expect(handle.signal.aborted).toBe(true);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    const err = onTimeout.mock.calls[0][0] as TimeoutError;
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.kind).toBe("step");
    expect(err.limitMs).toBe(1000);
  });

  it("per-run timeout fires onTimeout with kind=run", () => {
    const onTimeout = vi.fn();
    const handle = registry.register("run-5", {
      perStepTimeoutMs: 1_000_000,
      perRunTimeoutMs: 500,
      onTimeout,
    });

    vi.advanceTimersByTime(500);

    expect(handle.signal.aborted).toBe(true);
    const err = onTimeout.mock.calls[0][0] as TimeoutError;
    expect(err.kind).toBe("run");
    expect(err.limitMs).toBe(500);
  });

  it("bumpStep resets the per-step timer", () => {
    const onTimeout = vi.fn();
    const handle = registry.register("run-6", {
      perStepTimeoutMs: 1000,
      perRunTimeoutMs: 1_000_000,
      onTimeout,
    });

    vi.advanceTimersByTime(800);
    handle.bumpStep();
    vi.advanceTimersByTime(800);

    // 1.6s elapsed but bumped at 800ms, so per-step (1000ms) hasn't fired yet
    expect(handle.signal.aborted).toBe(false);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    expect(handle.signal.aborted).toBe(true);
  });

  describe("activity holds", () => {
    it("suspends the per-step timer while a tool call is in flight", () => {
      const onTimeout = vi.fn();
      const handle = registry.register("hold-1", {
        perStepTimeoutMs: 1000,
        perRunTimeoutMs: 1_000_000,
        onTimeout,
      });

      handle.holdStep();
      // Ten times the stall threshold: a tool that is still executing is not a
      // stalled step, however long it takes.
      vi.advanceTimersByTime(10_000);
      expect(onTimeout).not.toHaveBeenCalled();
      expect(handle.signal.aborted).toBe(false);

      handle.releaseStep();
      vi.advanceTimersByTime(999);
      expect(onTimeout).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(onTimeout).toHaveBeenCalledTimes(1);
    });

    it("keeps the timer suspended until the last parallel tool call releases", () => {
      const onTimeout = vi.fn();
      registry.register("hold-2", {
        perStepTimeoutMs: 1000,
        perRunTimeoutMs: 1_000_000,
        onTimeout,
      });
      const handle = registry.register("hold-2b", {
        perStepTimeoutMs: 1000,
        perRunTimeoutMs: 1_000_000,
        onTimeout,
      });

      handle.holdStep();
      handle.holdStep();
      handle.releaseStep();
      vi.advanceTimersByTime(5000);
      expect(handle.signal.aborted).toBe(false);

      handle.releaseStep();
      vi.advanceTimersByTime(1000);
      expect(handle.signal.aborted).toBe(true);
    });

    it("ignores a release with no matching hold rather than re-arming twice", () => {
      const onTimeout = vi.fn();
      const handle = registry.register("hold-3", {
        perStepTimeoutMs: 1000,
        perRunTimeoutMs: 1_000_000,
        onTimeout,
      });

      handle.releaseStep();
      handle.releaseStep();
      handle.holdStep();

      vi.advanceTimersByTime(5000);
      expect(handle.signal.aborted).toBe(false);
    });

    // The per-RUN ceiling is the backstop: a tool that never returns must not
    // buy the run unlimited wall-clock just by holding the step timer down.
    it("does not suspend the per-run timeout", () => {
      const onTimeout = vi.fn();
      const handle = registry.register("hold-4", {
        perStepTimeoutMs: 1_000_000,
        perRunTimeoutMs: 500,
        onTimeout,
      });

      handle.holdStep();
      vi.advanceTimersByTime(500);

      expect(handle.signal.aborted).toBe(true);
      expect((onTimeout.mock.calls[0][0] as TimeoutError).kind).toBe("run");
    });

    it("a hold taken after the run finished never re-arms a timer", () => {
      const onTimeout = vi.fn();
      const handle = registry.register("hold-5", {
        perStepTimeoutMs: 1000,
        onTimeout,
      });

      handle.holdStep();
      registry.unregister("hold-5");
      handle.releaseStep();

      vi.advanceTimersByTime(5000);
      expect(onTimeout).not.toHaveBeenCalled();
    });
  });

  it("cancel before timeout suppresses the timeout callback", () => {
    const onTimeout = vi.fn();
    registry.register("run-7", {
      perStepTimeoutMs: 1000,
      onTimeout,
    });

    registry.cancel("run-7");
    vi.advanceTimersByTime(2000);

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("default timeouts are exported and reasonable", () => {
    expect(DEFAULT_PER_STEP_TIMEOUT_MS).toBe(2 * 60 * 1000);
    expect(DEFAULT_PER_RUN_TIMEOUT_MS).toBe(10 * 60 * 1000);
  });

  it("has() reflects registration state", () => {
    expect(registry.has("x")).toBe(false);
    registry.register("x");
    expect(registry.has("x")).toBe(true);
    registry.unregister("x");
    expect(registry.has("x")).toBe(false);
  });

  // The per-step bound measures silence, not elapsed time. A step that streams
  // for longer than the bound is still working; only one that goes quiet for
  // the whole window is a stall. This is the regression from issue #552, where
  // a single long answer was aborted mid-stream at exactly the bound.
  describe("per-step timeout as an idle timeout", () => {
    it("noteActivity keeps a step alive far past the per-step bound", () => {
      const onTimeout = vi.fn();
      const handle = registry.register("idle-1", {
        perStepTimeoutMs: 1000,
        perRunTimeoutMs: 1_000_000,
        onTimeout,
      });

      // Ten times the bound, streaming steadily throughout, with no step ever
      // finishing — exactly the shape of one long answer.
      for (let i = 0; i < 20; i++) {
        vi.advanceTimersByTime(500);
        handle.noteActivity();
      }

      expect(onTimeout).not.toHaveBeenCalled();
      expect(handle.signal.aborted).toBe(false);
    });

    it("still fires once activity stops for the whole window", () => {
      const onTimeout = vi.fn();
      const handle = registry.register("idle-2", {
        perStepTimeoutMs: 1000,
        perRunTimeoutMs: 1_000_000,
        onTimeout,
      });

      vi.advanceTimersByTime(900);
      handle.noteActivity();
      // Silence from here. The timer that was armed at registration wakes at
      // 1000ms, finds 100ms of idle, and re-arms for the remaining 900ms.
      vi.advanceTimersByTime(1000);

      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect((onTimeout.mock.calls[0][0] as TimeoutError).kind).toBe("step");
      expect(handle.signal.aborted).toBe(true);
    });

    it("noteActivity does not defer the per-run bound", () => {
      const onTimeout = vi.fn();
      const handle = registry.register("idle-3", {
        perStepTimeoutMs: 1000,
        perRunTimeoutMs: 5000,
        onTimeout,
      });
      for (let i = 0; i < 12; i++) {
        vi.advanceTimersByTime(500);
        handle.noteActivity();
      }

      // A run that streams forever is still bounded — that is the whole point
      // of keeping the two timers independent.
      expect(
        onTimeout.mock.calls.some(
          (call) => (call[0] as TimeoutError).kind === "run",
        ),
      ).toBe(true);
    });

    it("noteActivity on an unknown or finished run is a no-op", () => {
      const handle = registry.register("idle-4", { perStepTimeoutMs: 1000 });
      registry.unregister("idle-4");
      expect(() => handle.noteActivity()).not.toThrow();
    });
  });

  describe("describeTimeout", () => {
    it("names the idle window for a step timeout", () => {
      const text = describeTimeout(
        new TimeoutError("internal wording", "step", 2 * 60 * 1000),
      );
      expect(text).toContain("2 minutes");
      expect(text).toContain("stopped sending output");
      // The internal message names a run id and a millisecond figure; neither
      // belongs in front of a user.
      expect(text).not.toContain("internal wording");
      expect(text).not.toContain("120000");
    });

    it("names the wall-clock bound for a run timeout", () => {
      const text = describeTimeout(
        new TimeoutError("internal", "run", 30 * 60 * 1000),
      );
      expect(text).toContain("30 minutes");
      expect(text).toContain("time limit");
    });

    it("uses seconds below the two-minute mark", () => {
      expect(describeTimeout(new TimeoutError("i", "step", 45_000))).toContain(
        "45 seconds",
      );
      expect(describeTimeout(new TimeoutError("i", "step", 1000))).toContain(
        "1 second",
      );
    });
  });
});
