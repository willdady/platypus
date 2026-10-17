"use client";

import type { ReactNode } from "react";
import {
  createContext,
  useContext,
  useCallback,
  useDeferredValue,
  useMemo,
} from "react";
import { createAuthClient } from "better-auth/react";
import { adminClient, inferAdditionalFields } from "better-auth/client/plugins";
import { useParams } from "next/navigation";
import useSWR from "swr";
import type { Workspace } from "@platypus/schemas";
import {
  type Actor,
  type WorkspaceDelegationFlags,
  resolveActor,
} from "@/lib/authorization";
import {
  scopedUrl,
  membershipEntity,
  workspaceEntity,
  type Serialized,
} from "@/lib/api-write";
import { fetcher, isNotFoundOrForbidden } from "@/lib/utils";

interface OrgMembership {
  id: string;
  organizationId: string;
  role: "admin" | "member";
}

interface AuthContextType {
  user: User | null;
  session: Session | null;
  isPending: boolean;
  isAuthLoading: boolean;
  error: Error | null;
  refreshSession: () => Promise<void>;
  orgMembership: OrgMembership | null;
  /** The named actor for this request — see `lib/authorization.ts`. */
  actor: Actor;
  /**
   * Literal Workspace ownership, independent of the `actor` tier — an Org
   * Admin who also owns this Workspace still resolves to the `"org-admin"`
   * actor, so `canSendChatMessages` needs this raw fact rather than `actor`.
   */
  ownsWorkspace: boolean;
  /** ADR-0006 delegation flags for the Workspace in scope, if any. */
  workspaceDelegation: WorkspaceDelegationFlags | null;
  /**
   * A session, membership or Workspace read that failed for a reason other
   * than access (a 5xx, the network), with nothing to fall back on. The
   * `user` and `actor` then say less than the caller may hold, so a gate
   * shows this as a retryable failure rather than turning the caller away.
   */
  accessReadError: unknown;
  /** Re-reads the session, the membership and the Workspace. */
  retryAccessReads: () => void;
}

/**
 * A read's error when it failed for a reason reading again might clear and
 * left no row behind. A 403 or 404 is the server's answer, not a failure;
 * a failed revalidation still has the row it had.
 */
const transientReadError = (error: unknown, data: unknown): unknown =>
  error && !data && !isNotFoundOrForbidden(error) ? error : null;

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/**
 * What stays fixed for the life of the page, kept apart from the session and
 * membership state so its readers don't re-render when those change.
 */
interface BackendContextType {
  backendUrl: string;
  authClient: AuthClient;
}

const BackendContext = createContext<BackendContextType | undefined>(undefined);

// One client per backend URL for the life of the page, outside React. The
// client owns the session store, and merely reading that store mounts it and
// fires `/auth/get-session`. A `useMemo` in the component is recomputed on
// every render attempt React throws away before the first commit — and while
// a slow page hydrates it throws away thousands — so each attempt made a new
// client and a new request: one reload sent 300+ `get-session` calls and
// tripped the backend's rate limiter (#1216). Here the store is created once,
// so every attempt reads the same one and it fetches once.
const authClients = new Map<string, AuthClient>();
const newAuthClient = (backendUrl: string) =>
  createAuthClient({
    baseURL: backendUrl,
    basePath: "/auth",
    plugins: [
      // Mirrors the backend's user additional fields so `updateUser` accepts them
      inferAdditionalFields({
        user: { timezone: { type: "string", required: false } },
      }),
      // Types the admin plugin's User fields (`role`, `banned`, …) and its
      // `authClient.admin.*` actions.
      adminClient(),
    ],
  });

type AuthClient = ReturnType<typeof newAuthClient>;

type AuthSession = AuthClient["$Infer"]["Session"];
/** The signed-in User, as better-auth returns it. */
export type User = AuthSession["user"];
/** The current session, without the token nothing here needs to hold. */
export type Session = Omit<AuthSession["session"], "token">;

const getAuthClient = (backendUrl: string) => {
  let client = authClients.get(backendUrl);
  if (!client) {
    client = newAuthClient(backendUrl);
    authClients.set(backendUrl, client);
  }
  return client;
};

export function AuthProvider({
  children,
  backendUrl,
}: {
  children: ReactNode;
  backendUrl: string;
}) {
  const authClient = getAuthClient(backendUrl);
  const backend = useMemo(
    () => ({ backendUrl, authClient }),
    [backendUrl, authClient],
  );

  const { data, isPending, error, refetch } = authClient.useSession();
  const rawSession = data?.session;
  const session = useMemo<Session | null>(() => {
    if (!rawSession) return null;
    const { token: _token, ...rest } = rawSession;
    return rest;
  }, [rawSession]);
  const params = useParams();

  const orgId = params.orgId as string | undefined;
  const workspaceId = params.workspaceId as string | undefined;
  // Depend on the user id rather than the user object so SWR revalidations
  // (which produce a new object identity) don't re-trigger these reads.
  const userId = data?.user?.id;

  // Membership and Workspace rows are reads, not hand-rolled effects: routing
  // them through SWR gives them a shared, per-key cache the pages read from
  // too, instead of a raw `fetch` invisible to every other consumer.
  const {
    data: orgMembership,
    error: orgMembershipError,
    isLoading: isOrgMembershipLoading,
    mutate: mutateOrgMembership,
  } = useSWR<Serialized<OrgMembership>>(
    userId && orgId ? scopedUrl(backendUrl, membershipEntity, { orgId }) : null,
    fetcher,
  );

  const {
    data: workspace,
    error: workspaceError,
    isLoading: isWorkspaceLoading,
    mutate: mutateWorkspace,
  } = useSWR<Serialized<Workspace>>(
    userId && orgId && workspaceId
      ? scopedUrl(backendUrl, workspaceEntity(workspaceId), { orgId })
      : null,
    fetcher,
  );

  // better-auth clears the session on a 401 — the server saying signed out —
  // and keeps it through any other failure, so only a session never read is
  // a failure to report. Taken as signed out, it sent the reader to /sign-in.
  const sessionReadError =
    error && !data && error.status !== 401 ? error : null;
  // A refused membership is the answer — not a member — whatever else
  // failed to load, so it leaves the gate to turn the caller away.
  const accessReadError =
    sessionReadError ??
    (isNotFoundOrForbidden(orgMembershipError)
      ? null
      : (transientReadError(orgMembershipError, orgMembership) ??
        transientReadError(workspaceError, workspace)));
  const retryAccessReads = useCallback(() => {
    void refetch();
    void mutateOrgMembership();
    void mutateWorkspace();
  }, [refetch, mutateOrgMembership, mutateWorkspace]);

  // Computed permissions
  const isSuperAdmin = data?.user?.role === "admin";
  // Both sides must be known: while neither has loaded, `undefined ===
  // undefined` would report an owner.
  const ownsWorkspace = !!userId && workspace?.ownerId === userId;
  const actor = resolveActor({
    isOperator: isSuperAdmin,
    orgRole: orgMembership?.role ?? null,
    ownsWorkspace,
  });
  // Keyed on the flags themselves, not the fetched row, so an SWR revalidation
  // that returns the same row doesn't hand consumers a new object identity.
  const hasWorkspace = !!workspace;
  const providerSelfManagement = workspace?.providerSelfManagement === true;
  const mcpSelfManagement = workspace?.mcpSelfManagement === true;
  const workspaceDelegation = useMemo<WorkspaceDelegationFlags | null>(
    () => (hasWorkspace ? { providerSelfManagement, mcpSelfManagement } : null),
    [hasWorkspace, providerSelfManagement, mcpSelfManagement],
  );

  // A read SWR is retrying after a failure is not loading as far as the gate
  // is concerned: it keeps showing the failure until a retry lands, instead
  // of flickering back to the page on every attempt.
  const isAuthLoading =
    isPending ||
    (!!data?.user &&
      ((!!orgId && isOrgMembershipLoading && !orgMembershipError) ||
        (!!workspaceId && isWorkspaceLoading && !workspaceError)));

  const value = useMemo<AuthContextType>(
    () => ({
      user: data?.user ?? null,
      session,
      isPending,
      isAuthLoading,
      error,
      refreshSession: refetch,
      orgMembership: orgMembership ?? null,
      actor,
      ownsWorkspace,
      workspaceDelegation,
      accessReadError,
      retryAccessReads,
    }),
    [
      data?.user,
      session,
      isPending,
      isAuthLoading,
      error,
      refetch,
      orgMembership,
      actor,
      ownsWorkspace,
      workspaceDelegation,
      accessReadError,
      retryAccessReads,
    ],
  );

  // The session lands as a synchronous store update, often while the page
  // below is still hydrating. Reaching a Suspense boundary that has not
  // hydrated yet, a synchronous update makes React throw away its server HTML
  // and show the route's loading fallback again: a reload flickered from the
  // page's skeleton to a blank one and back. Deferred, it waits for hydration.
  //
  // Only a loading value may lag, and consumers wait on it anyway. A settled
  // one never does: a stale signed-out value after sign-in would send a
  // protected page to /sign-in.
  const deferredValue = useDeferredValue(value);
  const provided = deferredValue.isAuthLoading ? deferredValue : value;

  return (
    <BackendContext.Provider value={backend}>
      <AuthContext.Provider value={provided}>{children}</AuthContext.Provider>
    </BackendContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}

function useBackend() {
  const context = useContext(BackendContext);
  if (context === undefined) {
    throw new Error(
      "useBackendUrl and useAuthClient must be used within an AuthProvider",
    );
  }
  return context;
}

export function useBackendUrl() {
  return useBackend().backendUrl;
}

export function useAuthClient() {
  return useBackend().authClient;
}
