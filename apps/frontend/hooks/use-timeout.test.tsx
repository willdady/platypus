import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useTimeout } from "./use-timeout";

describe("useTimeout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs the callback after the delay", () => {
    const fn = vi.fn();
    const { result } = renderHook(() => useTimeout());

    result.current(fn, 1000);
    vi.advanceTimersByTime(999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledOnce();
  });

  // Rapid clicks restart the delay rather than overlap: an earlier timer must
  // not cut a later one's feedback short.
  it("replaces a pending timer when scheduled again", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { result } = renderHook(() => useTimeout());

    result.current(first, 1000);
    vi.advanceTimersByTime(600);
    result.current(second, 1000);
    vi.advanceTimersByTime(600);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
  });

  it("drops a pending timer on unmount", () => {
    const fn = vi.fn();
    const { result, unmount } = renderHook(() => useTimeout());

    result.current(fn, 1000);
    unmount();
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });

  it("keeps the same schedule function across renders", () => {
    const { result, rerender } = renderHook(() => useTimeout());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
