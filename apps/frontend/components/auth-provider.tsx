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
import useSWR, { SWRConfig } from "swr";
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
import { fetcher, isNotFoundOrForbidden, joinUrl } from "@/lib/utils";
import { sessionExpiryHandler } from "@/lib/session-expiry";

type OrgMembership = {
  id: string;
  organizationId: string;
  role: "admin" | "member";
};

type AuthContextType = {
  user: User | null;
  session: Session | null;
  isPending: boolean;
  isAuthLoading: boolean;
  error: Error | null;
  refreshSession: () => Promise<void>;
  orgMembership: OrgMembership | null;
  actor: Actor;
  ownsWorkspace: boolean;
  workspaceDelegation: WorkspaceDelegationFlags | null;
  accessReadError: unknown;
  retryAccessReads: () => void;
};

function transientReadError(error: unknown, data: unknown): unknown {
  return error && !data && !isNotFoundOrForbidden(error) ? error : null;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

type BackendContextType = {
  backendUrl: string;
  authClient: AuthClient;
};

const BackendContext = createContext<BackendContextType | undefined>(undefined);

// why: outside React — a per-render client fired 300+ get-session calls (#1216)
const authClients = new Map<string, AuthClient>();
function newAuthClient(backendUrl: string) {
  return createAuthClient({
    // why: a prefixed baseURL makes better-auth ignore basePath, so /auth goes in the URL
    baseURL: joinUrl(backendUrl, "/auth"),
    plugins: [
      inferAdditionalFields({
        user: { timezone: { type: "string", required: false } },
      }),
      adminClient(),
    ],
  });
}

type AuthClient = ReturnType<typeof newAuthClient>;

type AuthSession = AuthClient["$Infer"]["Session"];
export type User = AuthSession["user"];
export type Session = Omit<AuthSession["session"], "token">;

function getAuthClient(backendUrl: string) {
  let client = authClients.get(backendUrl);
  if (!client) {
    client = newAuthClient(backendUrl);
    authClients.set(backendUrl, client);
  }
  return client;
}

export function AuthProvider({
  children,
  backendUrl,
}: {
  children: ReactNode;
  backendUrl: string;
}) {
  const authClient = getAuthClient(backendUrl);
  const { refetch } = authClient.useSession();
  const swrConfig = useMemo(
    () => ({ fetcher, onError: sessionExpiryHandler(refetch) }),
    [refetch],
  );
  return (
    <SWRConfig value={swrConfig}>
      <AuthState backendUrl={backendUrl} authClient={authClient}>
        {children}
      </AuthState>
    </SWRConfig>
  );
}

function AuthState({
  children,
  backendUrl,
  authClient,
}: {
  children: ReactNode;
  backendUrl: string;
  authClient: AuthClient;
}) {
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
  // why: the id, not the user object — a revalidation hands over a new identity
  const userId = data?.user?.id;

  // why: raw useSWR, not useScopedSWR — this read is the gate that hook waits on
  const {
    data: orgMembership,
    error: orgMembershipError,
    isLoading: isOrgMembershipLoading,
    mutate: mutateOrgMembership,
  } = useSWR<Serialized<OrgMembership>, unknown>(
    userId && orgId ? scopedUrl(backendUrl, membershipEntity, { orgId }) : null,
  );

  const {
    data: workspace,
    error: workspaceError,
    isLoading: isWorkspaceLoading,
    mutate: mutateWorkspace,
  } = useSWR<Serialized<Workspace>, unknown>(
    userId && orgId && workspaceId
      ? scopedUrl(backendUrl, workspaceEntity(workspaceId), { orgId })
      : null,
  );

  const sessionReadError =
    error && !data && error.status !== 401 ? error : null;
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

  const isSuperAdmin = data?.user?.role === "admin";
  const ownsWorkspace = !!userId && workspace?.ownerId === userId;
  const actor = resolveActor({
    isOperator: isSuperAdmin,
    orgRole: orgMembership?.role ?? null,
    ownsWorkspace,
  });
  // why: keyed on the flags, not the row — a revalidation must not change identity
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
