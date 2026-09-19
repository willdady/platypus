import { describe, it, expect, vi, beforeEach } from "vitest";
import { memo, useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";

const { sessionData } = vi.hoisted(() => ({
  sessionData: {
    user: { id: "u1", role: "user" },
    session: { token: "t" },
  },
}));

vi.mock("better-auth/react", () => ({
  createAuthClient: () => ({
    useSession: () => ({
      data: sessionData,
      isPending: false,
      error: null,
    }),
  }),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgId: "org1", workspaceId: "ws1" }),
}));

const { swrCalls, membership, workspace } = vi.hoisted(() => ({
  swrCalls: [] as string[],
  membership: { id: "m1", organizationId: "org1", role: "admin" as const },
  workspace: {
    ownerId: "u1",
    providerSelfManagement: true,
    mcpSelfManagement: false,
  },
}));

vi.mock("swr", () => ({
  __esModule: true,
  default: (key: string | null) => {
    if (key) swrCalls.push(key);
    if (key?.includes("/membership")) {
      return { data: membership, isLoading: false };
    }
    if (key?.includes("/workspaces/ws1")) {
      return { data: workspace, isLoading: false };
    }
    return { data: undefined, isLoading: false };
  },
}));

import { AuthProvider, useAuth } from "./auth-provider";

const onRender = vi.fn();

const Consumer = memo(function Consumer() {
  const { actor, ownsWorkspace, workspaceDelegation, orgMembership } =
    useAuth();
  onRender();
  return (
    <div>
      {actor}|{String(ownsWorkspace)}|
      {String(workspaceDelegation?.providerSelfManagement)}|
      {orgMembership?.role}
    </div>
  );
});

beforeEach(() => {
  swrCalls.length = 0;
  onRender.mockClear();
});

describe("AuthProvider", () => {
  it("reads membership and workspace through shared SWR keys", () => {
    render(
      <AuthProvider backendUrl="http://test">
        <Consumer />
      </AuthProvider>,
    );

    expect(swrCalls).toContain("http://test/organizations/org1/membership");
    expect(swrCalls).toContain("http://test/organizations/org1/workspaces/ws1");
  });

  it("resolves the actor and delegation flags from those rows", () => {
    render(
      <AuthProvider backendUrl="http://test">
        <Consumer />
      </AuthProvider>,
    );

    expect(screen.getByText("org-admin|true|true|admin")).toBeInTheDocument();
  });

  it("keeps the context value stable so an unrelated parent render doesn't reach consumers", () => {
    function Harness() {
      const [n, setN] = useState(0);
      return (
        <AuthProvider backendUrl="http://test">
          <button onClick={() => setN(n + 1)}>bump {n}</button>
          <Consumer />
        </AuthProvider>
      );
    }

    render(<Harness />);
    expect(onRender).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByRole("button"));

    expect(onRender).toHaveBeenCalledTimes(1);
  });
});
