import { describe, it, expect, vi, beforeEach } from "vitest";
import { memo, useRef, useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";

const { sessionData, sessionState } = vi.hoisted(() => {
  const sessionData = {
    user: { id: "u1", role: "user" },
    session: { token: "t" },
  };
  return {
    sessionData,
    sessionState: {
      data: sessionData as typeof sessionData | null,
      isPending: false,
    },
  };
});

vi.mock("better-auth/react", () => ({
  createAuthClient: () => ({
    useSession: () => ({ ...sessionState, error: null }),
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
  sessionState.data = sessionData;
  sessionState.isPending = false;
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

  // Neither the session nor the Workspace row is known yet, and `undefined ===
  // undefined` used to answer that question with "yes".
  it("reports no owner while the session is still loading", () => {
    sessionState.data = null;
    sessionState.isPending = true;

    render(
      <AuthProvider backendUrl="http://test">
        <Consumer />
      </AuthProvider>,
    );

    expect(screen.getByText(/\|false\|/)).toBeInTheDocument();
  });

  // What a protected page mounting straight after sign-in reads first. A value
  // that lagged here would still say signed out, and the page would redirect
  // to /sign-in.
  it("hands a page mounted as the session lands the new session", () => {
    sessionState.data = null;
    function Mounted() {
      const { user } = useAuth();
      const first = useRef(user?.id ?? "signed out");
      return <p>first saw {first.current}</p>;
    }
    const view = render(
      <AuthProvider backendUrl="http://test">
        <Consumer />
      </AuthProvider>,
    );

    sessionState.data = sessionData;
    view.rerender(
      <AuthProvider backendUrl="http://test">
        <Consumer />
        <Mounted />
      </AuthProvider>,
    );

    expect(screen.getByText("first saw u1")).toBeInTheDocument();
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
