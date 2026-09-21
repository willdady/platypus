"use client";

import { useAuth } from "@/components/auth-provider";
import {
  canAccessOrganization,
  canAccessWorkspace,
  isOperator,
} from "@/lib/authorization";
import { useParams, useRouter } from "next/navigation";
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
import { OctagonX, Home, Building } from "lucide-react";
import Link from "next/link";
import { orgRoutes } from "@/lib/routes";

interface ProtectedRouteProps {
  children: React.ReactNode;
  /** Require the caller to be an Org Admin, not merely a member. */
  requireOrgAdmin?: boolean;
  requireOrgAccess?: boolean;
  requireWorkspaceAccess?: boolean;
  requireSuperAdmin?: boolean;
}

interface AccessDeniedProps {
  title: string;
  description: React.ReactNode;
  /** `organization` swaps the home button for one back to the Organization. */
  variant?: "home" | "organization";
}

function AccessDenied({
  title,
  description,
  variant = "home",
}: AccessDeniedProps) {
  const params = useParams();
  const { href, text, Icon } =
    variant === "organization"
      ? {
          href: orgRoutes(params.orgId as string).root,
          text: "Back to Organization",
          Icon: Building,
        }
      : { href: "/", text: "Return Home", Icon: Home };

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
            <Link href={href}>
              <Icon className="size-4" />
              {text}
            </Link>
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}

export function ProtectedRoute({
  children,
  requireOrgAdmin = false,
  requireOrgAccess = false,
  requireWorkspaceAccess = false,
  requireSuperAdmin = false,
}: ProtectedRouteProps) {
  const { user, isAuthLoading, orgMembership, actor } = useAuth();
  const router = useRouter();

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

  if (requireSuperAdmin && !isOperator(actor)) {
    return (
      <AccessDenied
        title="Super Admin Access Required"
        description="You do not have permission to access this page. This area is restricted to system administrators."
      />
    );
  }

  if (requireOrgAccess) {
    const requiredOrgRole = requireOrgAdmin ? "admin" : "member";
    const orgAccess = canAccessOrganization(
      actor,
      orgMembership?.role ?? null,
      requiredOrgRole,
    );
    if (!orgAccess.allowed && orgAccess.reason === "not-a-member") {
      return (
        <AccessDenied
          title="Organization Access Required"
          description="You do not have permission to access this organization. Please contact your administrator or switch to an organization you have access to."
        />
      );
    }
    if (!orgAccess.allowed && orgAccess.reason === "insufficient-role") {
      return (
        <AccessDenied
          title="Insufficient Organization Permissions"
          description={
            <>
              You need <span className="font-semibold">{requiredOrgRole}</span>{" "}
              permissions to access this page. Your current role in this
              organization is{" "}
              <span className="font-semibold">{orgMembership?.role}</span>.
            </>
          }
        />
      );
    }
  }

  if (requireWorkspaceAccess && !canAccessWorkspace(actor)) {
    return (
      <AccessDenied
        title="Workspace Access Required"
        description="You do not have permission to access this workspace. You can only access workspaces you own."
        variant="organization"
      />
    );
  }

  return <>{children}</>;
}
