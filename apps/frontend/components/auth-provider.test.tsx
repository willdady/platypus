import { describe, it, expect, expectTypeOf, vi, beforeEach } from "vitest";
import { memo, useRef, useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";

type ReadState = {
  data: unknown;
  error: unknown;
  isLoading: boolean;
};

const { sessionData, sessionState } = vi.hoisted(() => {
  const sessionData = {
    user: { id: "u1", role: "user" },
    session: { token: "t" },
  };
  const sessionState: {
    data: typeof sessionData | null;
    isPending: boolean;
    error: { status: number } | null;
    refetch: ReturnType<typeof vi.fn>;
  } = {
    data: sessionData,
    isPending: false,
    error: null,
    refetch: vi.fn(),
  };
  return { sessionData, sessionState };
});

vi.mock("better-auth/react", () => ({
  createAuthClient: () => ({
    useSession: () => sessionState,
  }),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgId: "org1", workspaceId: "ws1" }),
}));

const { swrCalls, membership, workspace, reads } = vi.hoisted(() => {
  const membership = {
    id: "m1",
    organizationId: "org1",
    role: "admin" as const,
  };
  const workspace = {
    ownerId: "u1",
    providerSelfManagement: true,
    mcpSelfManagement: false,
  };
  // why: built once — a new identity each render would churn the memoised context
  const reads: {
    membership: ReadState;
    workspace: ReadState;
    mutateMembership: ReturnType<typeof vi.fn>;
    mutateWorkspace: ReturnType<typeof vi.fn>;
  } = {
    membership: {
      data: membership,
      error: undefined,
      isLoading: false,
    },
    workspace: {
      data: workspace,
      error: undefined,
      isLoading: false,
    },
    mutateMembership: vi.fn(),
    mutateWorkspace: vi.fn(),
  };
  return {
    swrCalls: [] as string[],
    membership,
    workspace,
    reads,
  };
});

const { swrConfig } = vi.hoisted(() => ({
  swrConfig: { current: undefined as Record<string, unknown> | undefined },
}));

vi.mock("swr", () => ({
  __esModule: true,
  SWRConfig: ({
    value,
    children,
  }: {
    value: Record<string, unknown>;
    children: React.ReactNode;
  }) => {
    swrConfig.current = value;
    return children;
  },
  default: (key: string | null) => {
    if (key) swrCalls.push(key);
    if (key?.includes("/membership")) {
      return { ...reads.membership, mutate: reads.mutateMembership };
    }
    if (key?.includes("/workspaces/ws1")) {
      return { ...reads.workspace, mutate: reads.mutateWorkspace };
    }
    return { data: undefined, isLoading: false, mutate: vi.fn() };
  },
}));

import { fetcher } from "@/lib/utils";
import {
  AuthProvider,
  useAuth,
  useBackendUrl,
  type Session,
} from "./auth-provider";

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
  reads.membership = { data: membership, error: undefined, isLoading: false };
  reads.workspace = { data: workspace, error: undefined, isLoading: false };
  reads.mutateMembership.mockReset();
  reads.mutateWorkspace.mockReset();
  onRender.mockClear();
  sessionState.data = sessionData;
  sessionState.isPending = false;
  sessionState.error = null;
  sessionState.refetch.mockReset();
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

  it("is the root SWR config: the shared fetcher, and a 401 re-reads the session", () => {
    render(
      <AuthProvider backendUrl="http://test">
        <Consumer />
      </AuthProvider>,
    );

    expect(swrConfig.current?.fetcher).toBe(fetcher);
    const onError = swrConfig.current?.onError as (error: unknown) => void;
    onError(Object.assign(new Error(), { status: 401 }));
    expect(sessionState.refetch).toHaveBeenCalledTimes(1);
  });

  it("resolves the actor and delegation flags from those rows", () => {
    render(
      <AuthProvider backendUrl="http://test">
        <Consumer />
      </AuthProvider>,
    );

    expect(screen.getByText("org-admin|true|true|admin")).toBeInTheDocument();
  });

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

describe("AuthProvider static backend context", () => {
  it("doesn't re-render a useBackendUrl() reader when the session or membership changes", () => {
    const onBackendRender = vi.fn();
    const BackendReader = memo(function BackendReader() {
      const backendUrl = useBackendUrl();
      onBackendRender();
      return <p>{backendUrl}</p>;
    });
    const tree = () => (
      <AuthProvider backendUrl="http://test">
        <BackendReader />
        <Consumer />
      </AuthProvider>
    );
    const view = render(tree());

    sessionState.data = { ...sessionData, user: { id: "u2", role: "user" } };
    view.rerender(tree());
    reads.membership = {
      data: { ...membership, role: "member" },
      error: undefined,
      isLoading: false,
    };
    view.rerender(tree());

    expect(onRender).toHaveBeenCalledTimes(3);
    expect(onBackendRender).toHaveBeenCalledTimes(1);
    expect(screen.getByText("http://test")).toBeInTheDocument();
  });
});

describe("AuthProvider session", () => {
  it("leaves the session token out", () => {
    sessionState.data = {
      ...sessionData,
      session: { id: "s1", token: "t" },
    } as typeof sessionData;
    let seen: Session | null = null;
    function SessionReader() {
      seen = useAuth().session;
      return null;
    }
    render(
      <AuthProvider backendUrl="http://test">
        <SessionReader />
      </AuthProvider>,
    );

    expect(seen).toEqual({ id: "s1" });
    expectTypeOf<Session>().not.toHaveProperty("token");
  });
});

describe("AuthProvider access read failures", () => {
  function AccessReadConsumer() {
    const { accessReadError, retryAccessReads, isAuthLoading } = useAuth();
    return (
      <button onClick={retryAccessReads}>
        {accessReadError ? "access read failed" : "access read ok"}
        {isAuthLoading ? " (loading)" : ""}
      </button>
    );
  }

  const renderConsumer = () =>
    render(
      <AuthProvider backendUrl="http://test">
        <AccessReadConsumer />
      </AuthProvider>,
    );

  it.each(["membership", "workspace"] as const)(
    "reports a %s read that failed for a reason other than access",
    (read) => {
      reads[read] = {
        data: undefined,
        error: { status: 500 },
        isLoading: false,
      };
      renderConsumer();

      expect(screen.getByText("access read failed")).toBeInTheDocument();
    },
  );

  it.each([403, 404])(
    "leaves a %i membership answer to the access gate",
    (status) => {
      reads.membership = {
        data: undefined,
        error: { status },
        isLoading: false,
      };
      renderConsumer();

      expect(screen.getByText("access read ok")).toBeInTheDocument();
    },
  );

  it("leaves a refused membership to the access gate even when the Workspace read fails", () => {
    reads.membership = {
      data: undefined,
      error: { status: 404 },
      isLoading: false,
    };
    reads.workspace = {
      data: undefined,
      error: { status: 500 },
      isLoading: false,
    };
    renderConsumer();

    expect(screen.getByText("access read ok")).toBeInTheDocument();
  });

  it("keeps reporting the failure, not loading, while SWR retries the read", () => {
    reads.membership = {
      data: undefined,
      error: { status: 500 },
      isLoading: true,
    };
    renderConsumer();

    expect(screen.getByText("access read failed")).toBeInTheDocument();
  });

  it("keeps a row already in hand when only its revalidation fails", () => {
    reads.membership = {
      data: membership,
      error: { status: 500 },
      isLoading: false,
    };
    renderConsumer();

    expect(screen.getByText("access read ok")).toBeInTheDocument();
  });

  it("retries both access reads", () => {
    reads.membership = {
      data: undefined,
      error: { status: 500 },
      isLoading: false,
    };
    renderConsumer();

    fireEvent.click(screen.getByRole("button"));

    expect(reads.mutateMembership).toHaveBeenCalled();
    expect(reads.mutateWorkspace).toHaveBeenCalled();
  });

  it("reports a session read that failed with no session in hand", () => {
    sessionState.data = null;
    sessionState.error = { status: 500 };
    renderConsumer();

    expect(screen.getByText("access read failed")).toBeInTheDocument();
  });

  it("leaves a 401 session read to the sign-in redirect", () => {
    sessionState.data = null;
    sessionState.error = { status: 401 };
    renderConsumer();

    expect(screen.getByText("access read ok")).toBeInTheDocument();
  });

  it("keeps a session already in hand when only its revalidation fails", () => {
    sessionState.error = { status: 500 };
    renderConsumer();

    expect(screen.getByText("access read ok")).toBeInTheDocument();
  });

  it("retries a failed session read", () => {
    sessionState.data = null;
    sessionState.error = { status: 500 };
    renderConsumer();

    fireEvent.click(screen.getByRole("button"));

    expect(sessionState.refetch).toHaveBeenCalled();
  });
});
