import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useStableSet } from "./use-stable-set";

describe("useStableSet", () => {
  it("keeps the previous identity when the contents are equal", () => {
    const first = new Set(["a", "b"]);
    const { result, rerender } = renderHook(({ next }) => useStableSet(next), {
      initialProps: { next: first },
    });
    expect(result.current).toBe(first);

    rerender({ next: new Set(["b", "a"]) });

    expect(result.current).toBe(first);
  });

  it("adopts a set whose contents changed", () => {
    const first = new Set(["a"]);
    const { result, rerender } = renderHook(({ next }) => useStableSet(next), {
      initialProps: { next: first },
    });

    const changed = new Set(["a", "b"]);
    rerender({ next: changed });
    expect(result.current).toBe(changed);

    const emptied = new Set<string>();
    rerender({ next: emptied });
    expect(result.current).toBe(emptied);
  });
});
