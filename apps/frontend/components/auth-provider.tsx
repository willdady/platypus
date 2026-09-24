"use client";

import {
  createContext,
  useContext,
  ReactNode,
  useDeferredValue,
  useMemo,
} from "react";
import { createAuthClient } from "better-auth/react";
import { useParams } from "next/navigation";
import useSWR from "swr";
import type { Workspace } from "@platypus/schemas";
import {
  type Actor,
  type WorkspaceDelegationFlags,
  resolveActor,
} from "@/lib/authorization";
import { scopedUrl, membershipEntity, workspaceEntity } from "@/lib/api-write";
import { fetcher } from "@/lib/utils";

interface OrgMembership {
  id: string;
  organizationId: string;
  role: "admin" | "member";
}

interface User {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: Date;
  updatedAt: Date;
  role: "user" | "admin";
  banned: boolean | null;
  banReason: string | null;
  banExpires: Date | null;
}

interface Session {
  id: string;
  expiresAt: Date;
  token: string;
  createdAt: Date;
  updatedAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  userId: string;
}

interface AuthContextType {
  backendUrl: string;
  user: User | null;
  session: Session | null;
  isPending: boolean;
  isAuthLoading: boolean;
  error: Error | null;
  authClient: ReturnType<typeof createAuthClient>;
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
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({
  children,
  backendUrl,
}: {
  children: ReactNode;
  backendUrl: string;
}) {
  const authClient = useMemo(() => {
    return createAuthClient({
      baseURL: backendUrl,
      basePath: "/auth",
    });
  }, [backendUrl]);

  const { data, isPending, error, refetch } = authClient.useSession();
  const params = useParams();

  const orgId = params.orgId as string | undefined;
  const workspaceId = params.workspaceId as string | undefined;
  // Depend on the user id rather than the user object so SWR revalidations
  // (which produce a new object identity) don't re-trigger these reads.
  const userId = data?.user?.id;

  // Membership and Workspace rows are reads, not hand-rolled effects: routing
  // them through SWR gives them a shared, per-key cache the pages read from
  // too, instead of a raw `fetch` invisible to every other consumer.
  const { data: orgMembership, isLoading: isOrgMembershipLoading } =
    useSWR<OrgMembership>(
      userId && orgId
        ? scopedUrl(backendUrl, membershipEntity, { orgId })
        : null,
      fetcher,
    );

  const { data: workspace, isLoading: isWorkspaceLoading } = useSWR<Workspace>(
    userId && orgId && workspaceId
      ? scopedUrl(backendUrl, workspaceEntity(workspaceId), { orgId })
      : null,
    fetcher,
  );

  // Computed permissions
  const isSuperAdmin =
    (data?.user as unknown as User | undefined)?.role === "admin";
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

  const isAuthLoading =
    isPending ||
    (!!data?.user &&
      ((!!orgId && isOrgMembershipLoading) ||
        (!!workspaceId && isWorkspaceLoading)));

  const value = useMemo<AuthContextType>(
    () => ({
      backendUrl,
      user: (data?.user as unknown as User) ?? null,
      session: (data?.session as unknown as Session) ?? null,
      isPending,
      isAuthLoading,
      error,
      authClient,
      refreshSession: refetch,
      orgMembership: orgMembership ?? null,
      actor,
      ownsWorkspace,
      workspaceDelegation,
    }),
    [
      backendUrl,
      data?.user,
      data?.session,
      isPending,
      isAuthLoading,
      error,
      authClient,
      refetch,
      orgMembership,
      actor,
      ownsWorkspace,
      workspaceDelegation,
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
    <AuthContext.Provider value={provided}>{children}</AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}

export function useBackendUrl() {
  return useAuth().backendUrl;
}
