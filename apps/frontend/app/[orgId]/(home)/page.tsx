"use client";

import { WorkspaceList } from "@/components/workspace-list";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Plus, Settings, FolderClosed } from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { canCreateWorkspace } from "@/lib/authorization";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import type { Workspace } from "@platypus/schemas";
import { use } from "react";
import { orgRoutes } from "@/lib/routes";

export default function OrgPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const { actor, isAuthLoading } = useAuth();
  const canCreate = canCreateWorkspace(actor).allowed;
  const routes = orgRoutes(orgId);

  const { data: workspacesData } = useScopedSWR<{
    results: Workspace[];
  }>("workspaces", { orgId });

  // Wait for the org-membership fetch too, not just workspaces. Switching orgs
  // clears orgMembership and re-fetches it; if workspaces resolve first,
  // canCreate is briefly false and the admin-only "Add workspace" button would
  // render late, shifting the toolbar. Gating on isAuthLoading keeps the button
  // row hidden until admin status is known so it appears fully formed.
  const isReady = !!workspacesData && !isAuthLoading;
  const workspaces = workspacesData?.results || [];

  return (
    <div className="space-y-6">
      {!isReady ? (
        <WorkspaceList orgId={orgId} />
      ) : workspaces.length > 0 ? (
        <div className="space-y-4">
          <WorkspaceList orgId={orgId} />
          <div className="flex items-center gap-2">
            {/* ADR-0008: Workspace creation is org-admin-only. */}
            {canCreate && (
              <Button asChild>
                <Link href={routes.createWorkspace}>
                  <Plus className="size-4" /> Add workspace
                </Link>
              </Button>
            )}
            <Button variant="outline" asChild>
              <Link href={routes.settings.root}>
                <Settings className="size-4" /> Organization settings
              </Link>
            </Button>
          </div>
        </div>
      ) : (
        <Empty className="border-2 border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderClosed />
            </EmptyMedia>
            <EmptyTitle>No workspaces found</EmptyTitle>
            <EmptyDescription>
              {canCreate
                ? "Create your first workspace in this organization to start building agents."
                : "You don't have a workspace yet. An organization admin can provision one for you."}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <div className="flex items-center gap-2">
              {/* ADR-0008: Workspace creation is org-admin-only. */}
              {canCreate && (
                <Button asChild className="flex-1">
                  <Link href={routes.createWorkspace}>
                    <Plus className="h-4 w-4" /> Create workspace
                  </Link>
                </Button>
              )}
              <Button variant="outline" asChild>
                <Link href={routes.settings.root}>
                  <Settings className="size-4" /> Organization settings
                </Link>
              </Button>
            </div>
          </EmptyContent>
        </Empty>
      )}
    </div>
  );
}
