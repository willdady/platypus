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

interface AuthContextType {
  user: any | null;
  session: any | null;
  isPending: boolean;
  isAuthLoading: boolean;
  error: any;
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

  // Fetch org membership when orgId changes
  useEffect(() => {
    if (!data?.user || !orgId) {
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
  }, [data?.user?.id, orgId, backendUrl]);

  // Fetch workspace data when workspaceId changes (to determine ownership)
  useEffect(() => {
    if (!data?.user || !workspaceId || !orgId) {
      setWorkspaceData(null);
      setHasFetchedWorkspace(false);
      setIsWorkspaceLoading(false);
      return;
    }

    setWorkspaceData(null);
    setHasFetchedWorkspace(false);
    setIsWorkspaceLoading(true);
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
  }, [data?.user?.id, orgId, workspaceId, backendUrl]);

  // Computed permissions
  const isOrgAdmin = orgMembership?.role === "admin";
  const isSuperAdmin = (data?.user as any)?.role === "admin";
  const isWorkspaceOwner = workspaceData?.ownerId === data?.user?.id;
  const hasWorkspaceAccess = isSuperAdmin || isOrgAdmin || isWorkspaceOwner;

  return (
    <AuthContext.Provider
      value={{
        user: data?.user ?? null,
        session: data?.session ?? null,
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
