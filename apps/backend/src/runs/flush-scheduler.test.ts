import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FlushScheduler } from "./flush-scheduler.ts";

describe("FlushScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("bump schedules a flush after intervalMs", async () => {
    const fn = vi.fn();
    const sched = new FlushScheduler(1000, fn);

    sched.bump();
    expect(fn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("repeated bumps within the interval coalesce to one call", async () => {
    const fn = vi.fn();
    const sched = new FlushScheduler(1000, fn);

    sched.bump();
    await vi.advanceTimersByTimeAsync(200);
    sched.bump();
    await vi.advanceTimersByTimeAsync(200);
    sched.bump();
    await vi.advanceTimersByTimeAsync(600);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("a new bump after a flush schedules another one", async () => {
    const fn = vi.fn();
    const sched = new FlushScheduler(1000, fn);

    sched.bump();
    await vi.advanceTimersByTimeAsync(1000);
    sched.bump();
    await vi.advanceTimersByTimeAsync(1000);

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("flush() runs immediately and clears the pending timer", async () => {
    const fn = vi.fn();
    const sched = new FlushScheduler(1000, fn);

    sched.bump();
    await sched.flush();
    expect(fn).toHaveBeenCalledTimes(1);

    // Pending timer was cleared, so advancing past intervalMs should not fire again
    await vi.advanceTimersByTimeAsync(2000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("dispose cancels pending flushes", async () => {
    const fn = vi.fn();
    const sched = new FlushScheduler(1000, fn);

    sched.bump();
    await sched.dispose();
    await vi.advanceTimersByTimeAsync(2000);

    expect(fn).not.toHaveBeenCalled();
  });

  it("dispose awaits any in-flight flush before resolving", async () => {
    let resolveFlush!: () => void;
    const fn = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFlush = resolve;
        }),
    );
    const sched = new FlushScheduler(100, fn);

    sched.bump();
    await vi.advanceTimersByTimeAsync(100);
    // flush is now running but its promise hasn't resolved
    expect(fn).toHaveBeenCalledTimes(1);

    let disposed = false;
    const disposePromise = sched.dispose().then(() => {
      disposed = true;
    });

    // Microtask flush — dispose should still be waiting on the in-flight fn
    await Promise.resolve();
    expect(disposed).toBe(false);

    resolveFlush();
    await disposePromise;
    expect(disposed).toBe(true);
  });

  it("bump after dispose is a no-op", async () => {
    const fn = vi.fn();
    const sched = new FlushScheduler(1000, fn);

    await sched.dispose();
    sched.bump();
    await vi.advanceTimersByTimeAsync(2000);

    expect(fn).not.toHaveBeenCalled();
  });

  it("flush after dispose is a no-op", async () => {
    const fn = vi.fn();
    const sched = new FlushScheduler(1000, fn);

    await sched.dispose();
    await sched.flush();

    expect(fn).not.toHaveBeenCalled();
  });

  it("swallows errors thrown by the flush function", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("boom"));
    const sched = new FlushScheduler(100, fn);

    sched.bump();
    await vi.advanceTimersByTimeAsync(100);
    // Should not have rejected
    sched.bump();
    await vi.advanceTimersByTimeAsync(100);

    expect(fn).toHaveBeenCalledTimes(2);
  });
});
