import { describe, it, expect, vi } from "vitest";
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

import { useWorkspace } from "./use-workspace";

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
