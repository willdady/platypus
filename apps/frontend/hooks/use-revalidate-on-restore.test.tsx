import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { firePageShow } from "@/test/test-utils";
import {
  RESTORE_THROTTLE_MS,
  useRevalidateOnRestore,
} from "./use-revalidate-on-restore";

describe("useRevalidateOnRestore", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("revalidates when the page is restored from the back/forward cache", () => {
    const revalidate = vi.fn();
    renderHook(() => useRevalidateOnRestore(revalidate));

    firePageShow(true);

    expect(revalidate).toHaveBeenCalledTimes(1);
  });

  it("ignores an ordinary page load", () => {
    const revalidate = vi.fn();
    renderHook(() => useRevalidateOnRestore(revalidate));

    firePageShow(false);

    expect(revalidate).not.toHaveBeenCalled();
  });

  it("collapses a burst of restores into a single revalidation", () => {
    const revalidate = vi.fn();
    renderHook(() => useRevalidateOnRestore(revalidate));

    firePageShow(true);
    firePageShow(true);
    firePageShow(true);

    expect(revalidate).toHaveBeenCalledTimes(1);
  });

  it("revalidates again on a later return", () => {
    vi.useFakeTimers();
    const revalidate = vi.fn();
    renderHook(() => useRevalidateOnRestore(revalidate));

    firePageShow(true);
    vi.advanceTimersByTime(RESTORE_THROTTLE_MS + 1);
    firePageShow(true);

    expect(revalidate).toHaveBeenCalledTimes(2);
  });

  it("calls the latest revalidate rather than the one it mounted with", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ fn }: { fn: () => void }) => useRevalidateOnRestore(fn),
      { initialProps: { fn: first } },
    );

    rerender({ fn: second });
    firePageShow(true);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("stops listening once unmounted", () => {
    const revalidate = vi.fn();
    const { unmount } = renderHook(() => useRevalidateOnRestore(revalidate));

    unmount();
    firePageShow(true);

    expect(revalidate).not.toHaveBeenCalled();
  });
});
