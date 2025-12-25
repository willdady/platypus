"use client";

import { useAuth } from "@/components/auth-provider";
import { useRouter, useParams } from "next/navigation";
import { useEffect } from "react";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Button } from "@/components/ui/button";
import { OctagonX, Home, Layout, Building } from "lucide-react";
import Link from "next/link";

type RequiredWorkspaceRole = "viewer" | "editor" | "admin";
type RequiredOrgRole = "member" | "admin";

interface ProtectedRouteProps {
  children: React.ReactNode;
  requiredWorkspaceRole?: RequiredWorkspaceRole;
  requiredOrgRole?: RequiredOrgRole;
  requireOrgAccess?: boolean;
  requireWorkspaceAccess?: boolean;
  requireSuperAdmin?: boolean;
}

const workspaceRoleHierarchy: Record<RequiredWorkspaceRole, number> = {
  viewer: 1,
  editor: 2,
  admin: 3,
};

const orgRoleHierarchy: Record<RequiredOrgRole, number> = {
  member: 1,
  admin: 2,
};

interface AccessDeniedProps {
  title: string;
  description: React.ReactNode;
  buttonHref?: string;
  buttonText?: string;
  buttonIcon?: React.ElementType;
}

function AccessDenied({
  title,
  description,
  buttonHref = "/",
  buttonText = "Return Home",
  buttonIcon: Icon = Home,
}: AccessDeniedProps) {
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Empty className="max-w-md border-2 border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <OctagonX className="size-6 text-destructive" />
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild>
            <Link href={buttonHref}>
              <Icon className="size-4" />
              {buttonText}
            </Link>
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}

export function ProtectedRoute({
  children,
  requiredWorkspaceRole = "viewer",
  requiredOrgRole = "member",
  requireOrgAccess = false,
  requireWorkspaceAccess = false,
  requireSuperAdmin = false,
}: ProtectedRouteProps) {
  const { user, isAuthLoading, orgMembership, workspaceRole } = useAuth();
  const router = useRouter();
  const params = useParams();

  useEffect(() => {
    // Not logged in - redirect to sign in
    if (!isAuthLoading && !user) {
      router.push("/sign-in");
      return;
    }

    // Need super admin but not one
    if (!isAuthLoading && requireSuperAdmin && user?.role !== "admin") {
      return;
    }

    // Need org access but not a member
    if (!isAuthLoading && requireOrgAccess && params.orgId && !orgMembership) {
      return;
    }

    // Need org access but insufficient role
    if (!isAuthLoading && requireOrgAccess && orgMembership) {
      const hasRole =
        orgRoleHierarchy[orgMembership.role] >=
        orgRoleHierarchy[requiredOrgRole];
      if (!hasRole) {
        return;
      }
    }

    // Need workspace access but no role
    if (
      !isAuthLoading &&
      requireWorkspaceAccess &&
      params.workspaceId &&
      !workspaceRole
    ) {
      return;
    }

    // Have workspace access but insufficient role
    if (!isAuthLoading && requireWorkspaceAccess && workspaceRole) {
      const hasRole =
        workspaceRoleHierarchy[workspaceRole] >=
        workspaceRoleHierarchy[requiredWorkspaceRole];
      if (!hasRole) {
        return;
      }
    }
  }, [
    user,
    isAuthLoading,
    orgMembership,
    workspaceRole,
    requiredWorkspaceRole,
    requireOrgAccess,
    requireWorkspaceAccess,
    requireSuperAdmin,
    params,
    router,
    requiredOrgRole,
  ]);

  if (isAuthLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="animate-pulse">Loading...</div>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  if (requireSuperAdmin && user?.role !== "admin") {
    return (
      <AccessDenied
        title="Super Admin Access Required"
        description="You do not have permission to access this page. This area is restricted to system administrators."
      />
    );
  }

  if (requireOrgAccess && !orgMembership) {
    return (
      <AccessDenied
        title="Organization Access Required"
        description="You do not have permission to access this organization. Please contact your administrator or switch to an organization you have access to."
      />
    );
  }

  if (requireOrgAccess && orgMembership) {
    const hasRole =
      orgRoleHierarchy[orgMembership.role] >= orgRoleHierarchy[requiredOrgRole];
    if (!hasRole) {
      return (
        <AccessDenied
          title="Insufficient Organization Permissions"
          description={
            <>
              You need <span className="font-semibold">{requiredOrgRole}</span>{" "}
              permissions to access this page. Your current role in this
              organization is{" "}
              <span className="font-semibold">{orgMembership.role}</span>.
            </>
          }
        />
      );
    }
  }

  if (requireWorkspaceAccess && !workspaceRole) {
    return (
      <AccessDenied
        title="Workspace Access Required"
        description="You do not have permission to access this workspace. Please contact your administrator or switch to a workspace you have access to."
        buttonHref={`/${params.orgId}`}
        buttonText="Back to Organization"
        buttonIcon={Building}
      />
    );
  }

  if (requireWorkspaceAccess && workspaceRole) {
    const hasRole =
      workspaceRoleHierarchy[workspaceRole] >=
      workspaceRoleHierarchy[requiredWorkspaceRole];
    if (!hasRole) {
      return (
        <AccessDenied
          title="Insufficient Permissions"
          description={
            <>
              You need{" "}
              <span className="font-semibold">{requiredWorkspaceRole}</span>{" "}
              permissions to access this page. Your current role is{" "}
              <span className="font-semibold">{workspaceRole}</span>.
            </>
          }
          buttonHref={`/${params.orgId}/workspace/${params.workspaceId}`}
          buttonText="Back to Workspace"
          buttonIcon={Layout}
        />
      );
    }
  }

  return <>{children}</>;
}
