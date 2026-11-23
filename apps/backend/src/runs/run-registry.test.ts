import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  RunRegistry,
  TimeoutError,
  DEFAULT_PER_STEP_TIMEOUT_MS,
  DEFAULT_PER_RUN_TIMEOUT_MS,
  describeTimeout,
} from "./run-registry.ts";
import { ConflictError, ServiceUnavailableError } from "../errors.ts";

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

  it("rejects a duplicate runId with a ConflictError", () => {
    registry.register("dup-1");

    expect(() => registry.register("dup-1")).toThrow(ConflictError);
  });

  it("frees the id for a later run once the first unregisters", () => {
    registry.register("dup-2");
    registry.unregister("dup-2");

    expect(() => registry.register("dup-2")).not.toThrow();
  });

  it("leaves the holding run untouched when a duplicate is rejected", () => {
    const handle = registry.register("dup-3", {
      perStepTimeoutMs: 1000,
      perRunTimeoutMs: 1_000_000,
    });

    expect(() => registry.register("dup-3")).toThrow(ConflictError);

    expect(handle.signal.aborted).toBe(false);
    expect(registry.cancel("dup-3")).toBe(true);
  });

  describe("stopping", () => {
    it("rejects new runs with a ServiceUnavailableError once stopping has begun", () => {
      registry.beginStop();

      expect(() => registry.register("late-run")).toThrow(
        ServiceUnavailableError,
      );
      expect(registry.heldRuns()).toEqual([]);
    });

    it("still cancels and unregisters held runs while stopping", () => {
      const handle = registry.register("held");
      registry.beginStop();

      expect(registry.cancel("held")).toBe(true);
      expect(handle.signal.aborted).toBe(true);
      registry.unregister("held");
      expect(registry.heldRuns()).toEqual([]);
      expect(() => registry.register("held")).toThrow(ServiceUnavailableError);
    });

    it("beginStop is idempotent", () => {
      registry.beginStop();
      registry.beginStop();

      expect(() => registry.register("run-1")).toThrow(ServiceUnavailableError);
    });
  });

  describe("a cancel decided at a moment", () => {
    it("stops a run that started before it", () => {
      const handle = registry.register("run-1");
      const decidedAt = Date.now() + 1;

      expect(registry.cancel("run-1", { startedBefore: decidedAt })).toBe(true);
      expect(handle.signal.aborted).toBe(true);
    });

    it("spares a run that started after it, under the same id", () => {
      const decidedAt = Date.now();
      vi.advanceTimersByTime(10);
      const handle = registry.register("run-1");

      expect(registry.cancel("run-1", { startedBefore: decidedAt })).toBe(
        false,
      );
      expect(handle.signal.aborted).toBe(false);
    });
  });

  it("lists the runs it holds, with when each started", () => {
    const startedAt = Date.now();
    registry.register("run-1");
    registry.register("run-2");
    registry.cancel("run-2");

    expect(registry.heldRuns()).toEqual([{ runId: "run-1", startedAt }]);
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

    it("a step bump during a hold does not re-arm the timer", () => {
      const onTimeout = vi.fn();
      const handle = registry.register("hold-6", {
        perStepTimeoutMs: 1000,
        perRunTimeoutMs: 1_000_000,
        onTimeout,
      });

      handle.holdStep();
      handle.bumpStep();
      vi.advanceTimersByTime(5000);

      expect(onTimeout).not.toHaveBeenCalled();
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

  describe("per-step timeout as an idle timeout", () => {
    it("noteActivity keeps a step alive far past the per-step bound", () => {
      const onTimeout = vi.fn();
      const handle = registry.register("idle-1", {
        perStepTimeoutMs: 1000,
        perRunTimeoutMs: 1_000_000,
        onTimeout,
      });

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
