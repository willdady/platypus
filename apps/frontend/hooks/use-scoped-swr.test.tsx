import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const authState: { user: { id: string } | null; isPending?: boolean } = {
  user: { id: "u1" },
};
vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://test",
  useAuth: () => authState,
}));

let capturedKey: unknown;
let capturedFetcher: unknown;
const cache = new Map<string, { data: unknown }>();
vi.mock("swr", () => ({
  __esModule: true,
  useSWRConfig: () => ({ cache }),
  default: (key: unknown, fn: unknown) => {
    capturedKey = key;
    capturedFetcher = fn;
    return { data: undefined, isLoading: false };
  },
}));

import { useScopedSWR } from "./use-scoped-swr";
import { fetcher, optionalFetcher } from "@/lib/utils";

describe("useScopedSWR", () => {
  afterEach(() => {
    authState.user = { id: "u1" };
    authState.isPending = false;
    cache.clear();
  });

  it("resolves the workspace-scoped URL as the SWR key", () => {
    renderHook(() =>
      useScopedSWR("providers", { orgId: "org1", workspaceId: "ws1" }),
    );
    expect(capturedKey).toBe(
      "http://test/organizations/org1/workspaces/ws1/providers",
    );
  });

  it("resolves the org-scoped URL when no workspace is given", () => {
    renderHook(() => useScopedSWR("agents", { orgId: "org1" }));
    expect(capturedKey).toBe("http://test/organizations/org1/agents");
  });

  it("withholds the key — rather than passing a falsy string SWR might still treat as a cache key — when scope is null", () => {
    renderHook(() => useScopedSWR("providers", null));
    expect(capturedKey).toBeNull();
  });

  it("withholds the key when there is no signed-in user", () => {
    authState.user = null;
    renderHook(() =>
      useScopedSWR("providers", { orgId: "org1", workspaceId: "ws1" }),
    );
    expect(capturedKey).toBeNull();
  });

  // Without this a hard refresh reads "loaded, empty" before the session
  // lands: a blank editable form, a false empty state.
  it("reports loading while the session is still resolving", () => {
    authState.user = null;
    authState.isPending = true;
    const { result } = renderHook(() =>
      useScopedSWR("providers", { orgId: "org1" }),
    );
    expect(capturedKey).toBeNull();
    expect(result.current.isLoading).toBe(true);
  });

  // A new Chat's row is seeded `null`: reporting it as loading showed the
  // existing-Chat transcript skeleton on a hard refresh of a new Chat.
  it("returns a value already cached under the pending key as loaded", () => {
    authState.user = null;
    authState.isPending = true;
    cache.set("http://test/organizations/org1/chat/c1", { data: null });
    const { result } = renderHook(() =>
      useScopedSWR("chat/c1", { orgId: "org1" }),
    );
    expect(capturedKey).toBeNull();
    expect(result.current.data).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it("does not report loading for a caller-withheld scope, even mid-session", () => {
    authState.user = null;
    authState.isPending = true;
    const { result } = renderHook(() => useScopedSWR("providers", null));
    expect(result.current.isLoading).toBe(false);
  });

  it("does not report loading once the session settles signed out", () => {
    authState.user = null;
    authState.isPending = false;
    const { result } = renderHook(() =>
      useScopedSWR("providers", { orgId: "org1" }),
    );
    expect(result.current.isLoading).toBe(false);
  });

  it("reads through the shared fetcher by default", () => {
    renderHook(() => useScopedSWR("providers", { orgId: "org1" }));
    expect(capturedFetcher).toBe(fetcher);
  });

  // Issue #648: the Chat detail read needs 404-as-absence, and only that read.
  it("lets one read swap its reader without changing the default", () => {
    renderHook(() =>
      useScopedSWR("chat/c1", { orgId: "org1" }, { fetcher: optionalFetcher }),
    );
    expect(capturedFetcher).toBe(optionalFetcher);

    renderHook(() => useScopedSWR("agents", { orgId: "org1" }));
    expect(capturedFetcher).toBe(fetcher);
  });
});
