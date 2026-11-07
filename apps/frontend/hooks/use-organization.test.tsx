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
vi.mock("swr", () => ({
  __esModule: true,
  useSWRConfig: () => ({ cache: new Map() }),
  default: (key: unknown) => {
    capturedKey = key;
    return { data: undefined, isLoading: false };
  },
}));

import { useOrganization, useWorkspace } from "./use-organization";

describe("useOrganization", () => {
  afterEach(() => {
    authState.user = { id: "u1" };
    authState.isPending = false;
  });

  it("reads the Organization row from the root scope, not nested under itself", () => {
    renderHook(() => useOrganization("org1"));
    expect(capturedKey).toBe("http://test/organizations/org1");
  });

  it("makes no request when disabled", () => {
    renderHook(() => useOrganization("org1", { enabled: false }));
    expect(capturedKey).toBeNull();
  });
});

describe("useWorkspace", () => {
  it("reads the Workspace row under its Organization's scope", () => {
    renderHook(() => useWorkspace("org1", "ws1"));
    expect(capturedKey).toBe("http://test/organizations/org1/workspaces/ws1");
  });

  it("makes no request when disabled", () => {
    renderHook(() => useWorkspace("org1", "ws1", { enabled: false }));
    expect(capturedKey).toBeNull();
  });
});
