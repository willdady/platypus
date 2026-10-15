import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useMediaQuery } from "./use-media-query";

const realMatchMedia = window.matchMedia;

/** A matchMedia stub whose single query list can be flipped and counted. */
function installMediaQueryList(initial: boolean) {
  const listeners = new Set<() => void>();
  const mql = {
    matches: initial,
    addEventListener: vi.fn((_: string, l: () => void) => listeners.add(l)),
    removeEventListener: vi.fn((_: string, l: () => void) =>
      listeners.delete(l),
    ),
  };
  window.matchMedia = vi.fn(() => mql) as unknown as typeof window.matchMedia;
  return {
    mql,
    set(matches: boolean) {
      mql.matches = matches;
      listeners.forEach((l) => l());
    },
  };
}

afterEach(() => {
  window.matchMedia = realMatchMedia;
});

describe("useMediaQuery", () => {
  it("reports whether the query matches and follows changes", () => {
    const media = installMediaQueryList(false);
    const { result } = renderHook(() => useMediaQuery("(pointer: fine)"));
    expect(result.current).toBe(false);

    act(() => media.set(true));
    expect(result.current).toBe(true);
  });

  it("keeps one subscription across re-renders", () => {
    const { mql } = installMediaQueryList(false);
    const { rerender } = renderHook(() => useMediaQuery("(pointer: fine)"));

    rerender();
    rerender();

    expect(mql.addEventListener).toHaveBeenCalledTimes(1);
    expect(mql.removeEventListener).not.toHaveBeenCalled();
  });
});
