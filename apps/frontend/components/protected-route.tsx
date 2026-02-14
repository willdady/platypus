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

type RequiredOrgRole = "member" | "admin";

interface ProtectedRouteProps {
  children: React.ReactNode;
  requiredOrgRole?: RequiredOrgRole;
  requireOrgAccess?: boolean;
  requireWorkspaceAccess?: boolean;
  requireSuperAdmin?: boolean;
}

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
  requiredOrgRole = "member",
  requireOrgAccess = false,
  requireWorkspaceAccess = false,
  requireSuperAdmin = false,
}: ProtectedRouteProps) {
  const { user, isAuthLoading, orgMembership, hasWorkspaceAccess } = useAuth();
  const router = useRouter();
  const params = useParams();

  useEffect(() => {
    if (!isAuthLoading && !user) {
      router.push("/sign-in");
    }
  }, [user, isAuthLoading, router]);

  if (isAuthLoading) {
    return <>{children}</>;
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

  if (requireWorkspaceAccess && !hasWorkspaceAccess) {
    return (
      <AccessDenied
        title="Workspace Access Required"
        description="You do not have permission to access this workspace. You can only access workspaces you own."
        buttonHref={`/${params.orgId}`}
        buttonText="Back to Organization"
        buttonIcon={Building}
      />
    );
  }

  return <>{children}</>;
}
