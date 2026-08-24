import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSearchToggle } from "./use-search-toggle";
import type { ResolvedModel } from "@/lib/resolve-model";

const searching: ResolvedModel = {
  label: "Model",
  concreteId: "model-1" as ResolvedModel["concreteId"],
  contextWindow: undefined,
  maxOutputTokens: undefined,
  passthroughFileTypes: [],
  canSearch: true,
};

const notSearching: ResolvedModel = { ...searching, canSearch: false };

describe("useSearchToggle", () => {
  it("starts off", () => {
    const { result } = renderHook(() => useSearchToggle(searching));
    expect(result.current[0]).toBe(false);
  });

  it("stays on switching between two selections that can both search", () => {
    const { result, rerender } = renderHook(
      ({ resolvedModel }: { resolvedModel: ResolvedModel | null }) =>
        useSearchToggle(resolvedModel),
      { initialProps: { resolvedModel: searching as ResolvedModel | null } },
    );

    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);

    // A different searchable selection (e.g. switching Agent) — search stays on.
    rerender({
      resolvedModel: {
        ...searching,
        concreteId: "model-2" as ResolvedModel["concreteId"],
      },
    });
    expect(result.current[0]).toBe(true);
  });

  it("forces off when switching to a selection that cannot search", () => {
    const { result, rerender } = renderHook(
      ({ resolvedModel }: { resolvedModel: ResolvedModel | null }) =>
        useSearchToggle(resolvedModel),
      { initialProps: { resolvedModel: searching as ResolvedModel | null } },
    );

    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);

    rerender({ resolvedModel: notSearching });
    expect(result.current[0]).toBe(false);
  });

  it("does not turn back on switching from a non-searching to a searching selection", () => {
    const { result, rerender } = renderHook(
      ({ resolvedModel }: { resolvedModel: ResolvedModel | null }) =>
        useSearchToggle(resolvedModel),
      { initialProps: { resolvedModel: notSearching as ResolvedModel | null } },
    );

    // Search was already forced/left off while on the non-searching selection.
    expect(result.current[0]).toBe(false);

    rerender({ resolvedModel: searching });
    expect(result.current[0]).toBe(false);
  });

  it("does nothing while the selection is unresolved, preserving the current setting", () => {
    const { result, rerender } = renderHook(
      ({ resolvedModel }: { resolvedModel: ResolvedModel | null }) =>
        useSearchToggle(resolvedModel),
      { initialProps: { resolvedModel: searching as ResolvedModel | null } },
    );

    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);

    // A brief loading/revalidation gap must not clobber the User's setting.
    rerender({ resolvedModel: null });
    expect(result.current[0]).toBe(true);

    rerender({ resolvedModel: searching });
    expect(result.current[0]).toBe(true);
  });
});
