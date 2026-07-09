"use client";

import {
  createContext,
  useContext,
  ReactNode,
  useMemo,
  useState,
  useEffect,
} from "react";
import { createAuthClient } from "better-auth/react";
import { useParams } from "next/navigation";

interface OrgMembership {
  id: string;
  organizationId: string;
  role: "admin" | "member";
}

interface WorkspaceData {
  ownerId: string;
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
  user: User | null;
  session: Session | null;
  isPending: boolean;
  isAuthLoading: boolean;
  error: Error | null;
  authClient: ReturnType<typeof createAuthClient>;
  orgMembership: OrgMembership | null;
  isOrgAdmin: boolean;
  isWorkspaceOwner: boolean;
  hasWorkspaceAccess: boolean;
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

  const { data, isPending, error } = authClient.useSession();
  const params = useParams();
  const [orgMembership, setOrgMembership] = useState<OrgMembership | null>(
    null,
  );
  const [workspaceData, setWorkspaceData] = useState<WorkspaceData | null>(
    null,
  );
  const [isOrgMembershipLoading, setIsOrgMembershipLoading] = useState(false);
  const [isWorkspaceLoading, setIsWorkspaceLoading] = useState(false);
  const [hasFetchedOrg, setHasFetchedOrg] = useState(false);
  const [hasFetchedWorkspace, setHasFetchedWorkspace] = useState(false);

  const orgId = params.orgId as string | undefined;
  const workspaceId = params.workspaceId as string | undefined;
  // Depend on the user id rather than the user object so SWR revalidations
  // (which produce a new object identity) don't re-trigger these fetches.
  const userId = data?.user?.id;

  // Manually fetch org membership when the org/user changes. This is a
  // data-fetching effect; the synchronous resets and loading flags below are
  // part of its fetch lifecycle (a future refactor could move this to SWR).
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    if (!userId || !orgId) {
      setOrgMembership(null);
      setHasFetchedOrg(false);
      setIsOrgMembershipLoading(false);
      return;
    }

    // If we already have the membership for this org, don't reset it
    if (orgMembership?.organizationId === orgId) {
      return;
    }

    setOrgMembership(null);
    setHasFetchedOrg(false);
    setIsOrgMembershipLoading(true);
    /* eslint-enable react-hooks/set-state-in-effect */
    fetch(`${backendUrl}/organizations/${orgId}/membership`, {
      credentials: "include",
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((membership) => {
        setOrgMembership(membership);
        setIsOrgMembershipLoading(false);
        setHasFetchedOrg(true);
      })
      .catch(() => {
        setOrgMembership(null);
        setIsOrgMembershipLoading(false);
        setHasFetchedOrg(true);
      });
  }, [userId, orgId, backendUrl, orgMembership?.organizationId]);

  // Manually fetch workspace data when the workspace/org/user changes (to
  // determine ownership). Data-fetching effect; the synchronous resets and
  // loading flags below are part of its fetch lifecycle.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    if (!userId || !workspaceId || !orgId) {
      setWorkspaceData(null);
      setHasFetchedWorkspace(false);
      setIsWorkspaceLoading(false);
      return;
    }

    setWorkspaceData(null);
    setHasFetchedWorkspace(false);
    setIsWorkspaceLoading(true);
    /* eslint-enable react-hooks/set-state-in-effect */
    fetch(`${backendUrl}/organizations/${orgId}/workspaces/${workspaceId}`, {
      credentials: "include",
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((ws) => {
        setWorkspaceData(ws ? { ownerId: ws.ownerId } : null);
        setIsWorkspaceLoading(false);
        setHasFetchedWorkspace(true);
      })
      .catch(() => {
        setWorkspaceData(null);
        setIsWorkspaceLoading(false);
        setHasFetchedWorkspace(true);
      });
  }, [userId, orgId, workspaceId, backendUrl]);

  // Computed permissions
  const isOrgAdmin = orgMembership?.role === "admin";
  const isSuperAdmin =
    (data?.user as unknown as User | undefined)?.role === "admin";
  const isWorkspaceOwner = workspaceData?.ownerId === data?.user?.id;
  const hasWorkspaceAccess = isSuperAdmin || isOrgAdmin || isWorkspaceOwner;

  return (
    <AuthContext.Provider
      value={{
        user: (data?.user as unknown as User) ?? null,
        session: (data?.session as unknown as Session) ?? null,
        isPending,
        isAuthLoading:
          isPending ||
          (!!data?.user &&
            ((!!orgId && (isOrgMembershipLoading || !hasFetchedOrg)) ||
              (!!workspaceId && (isWorkspaceLoading || !hasFetchedWorkspace)))),
        error,
        authClient,
        orgMembership,
        isOrgAdmin,
        isWorkspaceOwner,
        hasWorkspaceAccess,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
