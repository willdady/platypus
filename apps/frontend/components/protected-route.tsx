"use client";

import { useAuth } from "@/components/auth-provider";
import { useRouter, useParams } from "next/navigation";
import { useEffect } from "react";

type RequiredRole = "viewer" | "editor" | "admin";

interface ProtectedRouteProps {
  children: React.ReactNode;
  requiredRole?: RequiredRole;
  requireOrgAccess?: boolean;
  requireWorkspaceAccess?: boolean;
}

const roleHierarchy: Record<RequiredRole, number> = {
  viewer: 1,
  editor: 2,
  admin: 3,
};

export function ProtectedRoute({
  children,
  requiredRole = "viewer",
  requireOrgAccess = false,
  requireWorkspaceAccess = false,
}: ProtectedRouteProps) {
  const {
    user,
    isPending,
    orgMembership,
    workspaceRole,
  } = useAuth();
  const router = useRouter();
  const params = useParams();

  useEffect(() => {
    // Not logged in - redirect to sign in
    if (!isPending && !user) {
      router.push("/sign-in");
      return;
    }

    // Need org access but not a member
    if (!isPending && requireOrgAccess && params.orgId && !orgMembership) {
      router.push("/"); // Redirect to org selection
      return;
    }

    // Need workspace access but no role
    if (!isPending && requireWorkspaceAccess && params.workspaceId && !workspaceRole) {
      router.push(`/${params.orgId}`); // Redirect to workspace selection
      return;
    }

    // Have workspace access but insufficient role
    if (!isPending && requireWorkspaceAccess && workspaceRole) {
      const hasRole = roleHierarchy[workspaceRole] >= roleHierarchy[requiredRole];
      if (!hasRole) {
        // Could show an "access denied" page instead
        router.push(`/${params.orgId}/workspace/${params.workspaceId}`);
      }
    }
  }, [user, isPending, orgMembership, workspaceRole, requiredRole, requireOrgAccess, requireWorkspaceAccess, params, router]);

  if (isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="animate-pulse">Loading...</div>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  if (requireOrgAccess && !orgMembership) {
    return null;
  }

  if (requireWorkspaceAccess && !workspaceRole) {
    return null;
  }

  if (requireWorkspaceAccess && workspaceRole) {
    const hasRole = roleHierarchy[workspaceRole] >= roleHierarchy[requiredRole];
    if (!hasRole) {
      return null;
    }
  }

  return <>{children}</>;
}
