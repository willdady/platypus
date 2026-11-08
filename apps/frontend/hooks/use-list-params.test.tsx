import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useListParams, useSearchParamInput } from "./use-list-params";

const { searchParams } = vi.hoisted(() => ({
  searchParams: { current: new URLSearchParams() },
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams.current,
}));

function urlParams() {
  return new URLSearchParams(window.location.search);
}

beforeEach(() => {
  searchParams.current = new URLSearchParams();
  window.history.replaceState(null, "", "/");
});

describe("useListParams", () => {
  it("reads a param from the URL", () => {
    searchParams.current = new URLSearchParams("boardQuery=alpha");
    const { result } = renderHook(() => useListParams("boardsPage"));

    expect(result.current.get("boardQuery")).toBe("alpha");
    expect(result.current.get("boardsPage")).toBeNull();
  });

  it("writes a filter and starts the list on page 1", () => {
    window.history.replaceState(null, "", "?boardsPage=3");
    const { result } = renderHook(() => useListParams("boardsPage"));

    act(() => result.current.set("boardQuery", "alpha"));

    expect(urlParams().get("boardQuery")).toBe("alpha");
    expect(urlParams().has("boardsPage")).toBe(false);
  });

  it("drops an empty value from the URL", () => {
    window.history.replaceState(null, "", "?boardQuery=alpha&boardsPage=2");
    const { result } = renderHook(() => useListParams("boardsPage"));

    act(() => result.current.set("boardQuery", ""));

    expect(urlParams().has("boardQuery")).toBe(false);
    expect(urlParams().has("boardsPage")).toBe(false);
  });

  it("drops the default null value from the URL", () => {
    window.history.replaceState(null, "", "?boardQuery=alpha");
    const { result } = renderHook(() => useListParams("boardsPage"));

    act(() => result.current.set("boardQuery", null));

    expect(window.location.search).toBe("");
  });

  it("only writes when the list is not paged", () => {
    window.history.replaceState(null, "", "?page=2");
    const { result } = renderHook(() => useListParams());

    act(() => result.current.set("status", "failed"));

    expect(urlParams().get("status")).toBe("failed");
    expect(urlParams().get("page")).toBe("2");
  });

  it("reads the page the URL asks for", () => {
    searchParams.current = new URLSearchParams("boardsPage=2");
    const { result } = renderHook(() => useListParams("boardsPage"));

    expect(result.current.page(["a", "b", "c", "d", "e"], 2)).toMatchObject({
      items: ["c", "d"],
      page: 2,
      pageCount: 3,
    });
  });
});

describe("useSearchParamInput", () => {
  it("seeds the input from the URL", () => {
    searchParams.current = new URLSearchParams("boardQuery=alpha");
    const { result } = renderHook(() =>
      useSearchParamInput("boardQuery", "boardsPage"),
    );

    expect(result.current.value).toBe("alpha");
  });

  it("writes the trimmed search and starts on page 1", () => {
    window.history.replaceState(null, "", "?boardsPage=3");
    const { result } = renderHook(() =>
      useSearchParamInput("boardQuery", "boardsPage"),
    );

    act(() => result.current.onValueChange("  alpha  "));

    expect(result.current.value).toBe("  alpha  ");
    expect(urlParams().get("boardQuery")).toBe("alpha");
    expect(urlParams().has("boardsPage")).toBe(false);
  });

  it("leaves a blank search out of the URL", () => {
    window.history.replaceState(null, "", "?boardQuery=alpha");
    const { result } = renderHook(() =>
      useSearchParamInput("boardQuery", "boardsPage"),
    );

    act(() => result.current.onValueChange("   "));

    expect(window.location.search).toBe("");
  });
});
