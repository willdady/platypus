import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  RESTORE_THROTTLE_MS,
  useRevalidateOnRestore,
} from "./use-revalidate-on-restore";

/** A `pageshow` as the browser fires it; jsdom has no PageTransitionEvent. */
function pageshow(persisted: boolean) {
  const event = new Event("pageshow");
  Object.defineProperty(event, "persisted", { value: persisted });
  window.dispatchEvent(event);
}

describe("useRevalidateOnRestore", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // The gap SWR's own focus and reconnect revalidation leaves: a restored page
  // was frozen, so its poll has not been polling and what is on screen is as
  // old as the moment it was put away.
  it("revalidates when the page is restored from the back/forward cache", () => {
    const revalidate = vi.fn();
    renderHook(() => useRevalidateOnRestore(revalidate));

    pageshow(true);

    expect(revalidate).toHaveBeenCalledTimes(1);
  });

  // An ordinary navigation fires `pageshow` too, and that page already
  // revalidates on mount — acting on it would double every page load.
  it("ignores an ordinary page load", () => {
    const revalidate = vi.fn();
    renderHook(() => useRevalidateOnRestore(revalidate));

    pageshow(false);

    expect(revalidate).not.toHaveBeenCalled();
  });

  // Some browsers fire a restore alongside their own focus event, which SWR
  // revalidates on separately. Coming back must cost one request, not several.
  it("collapses a burst of restores into a single revalidation", () => {
    const revalidate = vi.fn();
    renderHook(() => useRevalidateOnRestore(revalidate));

    pageshow(true);
    pageshow(true);
    pageshow(true);

    expect(revalidate).toHaveBeenCalledTimes(1);
  });

  it("revalidates again on a later return", () => {
    vi.useFakeTimers();
    const revalidate = vi.fn();
    renderHook(() => useRevalidateOnRestore(revalidate));

    pageshow(true);
    vi.advanceTimersByTime(RESTORE_THROTTLE_MS + 1);
    pageshow(true);

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
    pageshow(true);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("stops listening once unmounted", () => {
    const revalidate = vi.fn();
    const { unmount } = renderHook(() => useRevalidateOnRestore(revalidate));

    unmount();
    pageshow(true);

    expect(revalidate).not.toHaveBeenCalled();
  });
});
