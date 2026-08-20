import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("@/app/client-context", () => ({
  useBackendUrl: () => "http://test",
}));

const authState: { user: { id: string } | null } = { user: { id: "u1" } };
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => authState,
}));

let capturedKey: unknown;
vi.mock("swr", () => ({
  __esModule: true,
  default: (key: unknown) => {
    capturedKey = key;
    return { data: undefined, isLoading: false };
  },
}));

import { useScopedSWR } from "./use-scoped-swr";

describe("useScopedSWR", () => {
  afterEach(() => {
    authState.user = { id: "u1" };
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
});
