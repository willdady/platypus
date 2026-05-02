import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  RunRegistry,
  TimeoutError,
  DEFAULT_PER_STEP_TIMEOUT_MS,
  DEFAULT_PER_RUN_TIMEOUT_MS,
} from "./run-registry.ts";

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

  it("registering the same runId twice throws", () => {
    registry.register("dup");
    expect(() => registry.register("dup")).toThrow(/already registered/);
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
});
