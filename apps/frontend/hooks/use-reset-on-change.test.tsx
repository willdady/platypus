import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useResetOnChange } from "./use-reset-on-change";

describe("useResetOnChange", () => {
  it("runs reset on the first render when the key is already present (warm cache)", () => {
    const reset = vi.fn();
    const agent = { id: "agent-1" };
    renderHook(() => useResetOnChange(agent, reset));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("runs reset once even when the key is undefined on first render (cold load)", () => {
    const reset = vi.fn();
    renderHook(() => useResetOnChange(undefined, reset));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("re-runs reset when the key changes after the first render", () => {
    const reset = vi.fn();
    const { rerender } = renderHook(({ key }) => useResetOnChange(key, reset), {
      initialProps: { key: undefined as { id: string } | undefined },
    });
    expect(reset).toHaveBeenCalledTimes(1);

    const agent = { id: "agent-1" };
    rerender({ key: agent });
    expect(reset).toHaveBeenCalledTimes(2);

    rerender({ key: agent });
    expect(reset).toHaveBeenCalledTimes(2);

    rerender({ key: { id: "agent-2" } });
    expect(reset).toHaveBeenCalledTimes(3);
  });

  it("does not re-run reset on re-renders when the key is stable", () => {
    const reset = vi.fn();
    const key = { id: "agent-1" };
    const { rerender } = renderHook(() => useResetOnChange(key, reset));
    rerender();
    rerender();
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
