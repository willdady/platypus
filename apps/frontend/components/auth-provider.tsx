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
  organisationId: string;
  role: "admin" | "member";
}

interface WorkspaceMembership {
  id: string;
  workspaceId: string;
  role: "admin" | "editor" | "viewer";
  inherited?: boolean;
}

interface AuthContextType {
  user: any | null;
  session: any | null;
  isPending: boolean;
  isAuthLoading: boolean;
  error: any;
  authClient: ReturnType<typeof createAuthClient>;
  orgMembership: OrgMembership | null;
  workspaceMembership: WorkspaceMembership | null;
  workspaceRole: "admin" | "editor" | "viewer" | null;
  isOrgAdmin: boolean;
  canEdit: boolean;
  canManage: boolean;
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
  const [workspaceMembership, setWorkspaceMembership] =
    useState<WorkspaceMembership | null>(null);
  const [isOrgMembershipLoading, setIsOrgMembershipLoading] = useState(false);
  const [isWorkspaceMembershipLoading, setIsWorkspaceMembershipLoading] =
    useState(false);
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
    // This prevents unmounting children in ProtectedRoute during revalidation
    if (orgMembership?.organisationId === orgId) {
      return;
    }

    setOrgMembership(null);
    setHasFetchedOrg(false);
    setIsOrgMembershipLoading(true);
    fetch(`${backendUrl}/organisations/${orgId}/membership`, {
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

  // Fetch workspace membership when workspaceId changes
  useEffect(() => {
    if (!data?.user || !workspaceId || !orgId) {
      setWorkspaceMembership(null);
      setHasFetchedWorkspace(false);
      setIsWorkspaceMembershipLoading(false);
      return;
    }

    // If we already have the membership for this workspace, don't reset it
    if (workspaceMembership?.workspaceId === workspaceId) {
      return;
    }

    setWorkspaceMembership(null);
    setHasFetchedWorkspace(false);
    setIsWorkspaceMembershipLoading(true);
    fetch(
      `${backendUrl}/organisations/${orgId}/workspaces/${workspaceId}/membership`,
      {
        credentials: "include",
      },
    )
      .then((res) => (res.ok ? res.json() : null))
      .then((membership) => {
        setWorkspaceMembership(membership);
        setIsWorkspaceMembershipLoading(false);
        setHasFetchedWorkspace(true);
      })
      .catch(() => {
        setWorkspaceMembership(null);
        setIsWorkspaceMembershipLoading(false);
        setHasFetchedWorkspace(true);
      });
  }, [data?.user?.id, orgId, workspaceId, backendUrl]);

  // Computed permissions
  const isOrgAdmin = orgMembership?.role === "admin";
  const workspaceRole = isOrgAdmin
    ? "admin"
    : (workspaceMembership?.role ?? null);
  const canEdit = workspaceRole === "admin" || workspaceRole === "editor";
  const canManage = workspaceRole === "admin";

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
              (!!workspaceId &&
                (isWorkspaceMembershipLoading || !hasFetchedWorkspace)))),
        error,
        authClient,
        orgMembership,
        workspaceMembership,
        workspaceRole,
        isOrgAdmin,
        canEdit,
        canManage,
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
