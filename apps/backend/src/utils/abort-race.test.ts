import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CallerAbortedError,
  DeadlineExceededError,
  raceAbort,
  withDeadline,
} from "./abort-race.ts";

const never = () => new Promise<never>(() => {});

describe("raceAbort", () => {
  it("rejects on abort even when the work ignores its signal", async () => {
    const controller = new AbortController();
    const raced = raceAbort(controller.signal, never);
    controller.abort("stop");
    await expect(raced).rejects.toMatchObject({
      message: "aborted",
      cause: "stop",
    });
  });

  it("never invokes the work when the signal has already aborted", async () => {
    const work = vi.fn(never);
    await expect(raceAbort(AbortSignal.abort("gone"), work)).rejects.toThrow(
      "aborted",
    );
    expect(work).not.toHaveBeenCalled();
  });

  it("releases its abort listener once the work settles", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    await expect(raceAbort(controller.signal, () => 1)).resolves.toBe(1);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

describe("withDeadline", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("leaves no timer behind after a call that succeeds", async () => {
    vi.useFakeTimers();
    await expect(withDeadline(() => "ok", 60_000)).resolves.toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a deadline that fired as a timeout", async () => {
    vi.useFakeTimers();
    const call = withDeadline(never, 100);
    const settled = expect(call).rejects.toBeInstanceOf(DeadlineExceededError);
    await vi.advanceTimersByTimeAsync(100);
    await settled;
  });

  it("reports the caller's abort as a cancellation", async () => {
    const caller = new AbortController();
    const call = withDeadline(never, 60_000, caller.signal);
    caller.abort();
    await expect(call).rejects.toBeInstanceOf(CallerAbortedError);
  });

  it("reports a timeout when the caller aborts in the same instant", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const call = withDeadline(
      (signal) => {
        signal.addEventListener("abort", () => caller.abort());
        return never();
      },
      100,
      caller.signal,
    );
    const settled = expect(call).rejects.toBeInstanceOf(DeadlineExceededError);
    await vi.advanceTimersByTimeAsync(100);
    await settled;
  });
});
