import { describe, it, expect, expectTypeOf, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://test",
  useAuth: () => ({ user: { id: "u1" }, isPending: false }),
}));

const swr: { key: unknown; data: unknown } = {
  key: undefined,
  data: undefined,
};
const mutate = vi.fn();
vi.mock("swr", () => ({
  __esModule: true,
  useSWRConfig: () => ({ cache: new Map() }),
  default: (key: unknown) => {
    swr.key = key;
    return { data: swr.data, isLoading: false, mutate };
  },
}));

import type { Agent } from "@platypus/schemas";
import { useScopedList } from "./use-scoped-list";

const scope = { orgId: "org1", workspaceId: "ws1" };

describe("useScopedList", () => {
  afterEach(() => {
    swr.key = undefined;
    swr.data = undefined;
  });

  it("types a fetched row's schema timestamp as the string JSON carries", () => {
    type Row = ReturnType<typeof useScopedList<Agent>>["results"][number];
    expectTypeOf<Row["createdAt"]>().toEqualTypeOf<string>();
  });

  it("unwraps the envelope's results", () => {
    const rows = [{ id: "a1" }];
    swr.data = { results: rows };
    const { result } = renderHook(() => useScopedList("agents", scope));
    expect(result.current.results).toBe(rows);
  });

  it("returns [] with no data, keeping the envelope on data and mutate", () => {
    const { result } = renderHook(() => useScopedList("agents", scope));
    expect(result.current.results).toEqual([]);
    expect(result.current.data).toBeUndefined();
    expect(result.current.mutate).toBe(mutate);
  });

  it("keeps the empty list's reference across rerenders", () => {
    const { result, rerender } = renderHook(() =>
      useScopedList("agents", scope),
    );
    const first = result.current.results;
    rerender();
    expect(result.current.results).toBe(first);
  });

  it("withholds the fetch and returns [] for a null scope", () => {
    const { result } = renderHook(() => useScopedList("agents", null));
    expect(swr.key).toBeNull();
    expect(result.current.results).toEqual([]);
  });
});
