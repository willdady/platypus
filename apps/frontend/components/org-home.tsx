"use client";

import { WorkspaceList } from "@/components/workspace-list";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Plus, Settings, FolderClosed } from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { useScopedList } from "@/hooks/use-scoped-list";
import { canCreateWorkspace, canOpenOrgSettings } from "@/lib/authorization";
import { EmptyCard } from "@/components/empty-card";
import { ButtonRowSkeleton } from "@/components/list-skeletons";
import { ListFooter } from "@/components/list-pagination";
import type { Workspace } from "@platypus/schemas";
import { orgRoutes } from "@/lib/routes";

// why: the page and its loading fallback both draw this, so an org switch keeps it up
export function OrgHome({ orgId }: { orgId: string }) {
  const { actor, isAuthLoading } = useAuth();
  const canCreate = canCreateWorkspace(actor);
  const canOpenSettings = canOpenOrgSettings(actor);
  const routes = orgRoutes(orgId);

  const {
    data: workspacesData,
    results: workspaces,
    error: workspacesError,
  } = useScopedList<Workspace>("workspaces", { orgId });

  // why: wait for the membership fetch too, or admin buttons appear late and shift the bar
  const isReady = (!!workspacesData || !!workspacesError) && !isAuthLoading;

  const actions = (
    <>
      {canCreate && (
        <Button variant={workspaces.length ? "outline" : "default"} asChild>
          <Link href={routes.createWorkspace}>
            <Plus /> Add workspace
          </Link>
        </Button>
      )}
      {canOpenSettings && (
        <Button variant="outline" asChild>
          <Link href={routes.settings.root}>
            <Settings /> Organization settings
          </Link>
        </Button>
      )}
    </>
  );

  return (
    <div className="flex flex-col gap-6">
      <h1 className="sr-only">Workspaces</h1>
      {!isReady ? (
        <div className="flex flex-col gap-4">
          <WorkspaceList orgId={orgId} />
          <ButtonRowSkeleton
            widths={[
              ...(isAuthLoading || canCreate ? ["w-36"] : []),
              ...(isAuthLoading || canOpenSettings ? ["w-48"] : []),
            ]}
          />
        </div>
      ) : workspaces.length > 0 || workspacesError ? (
        <div className="flex flex-col gap-4">
          <WorkspaceList orgId={orgId} />
          <ListFooter>{actions}</ListFooter>
        </div>
      ) : (
        <EmptyCard
          icon={<FolderClosed />}
          title="No workspaces yet"
          description={
            canCreate
              ? "Create your first workspace in this organization to start building agents."
              : "You don't have a workspace yet. An organization admin can provision one for you."
          }
          action={actions}
        />
      )}
    </div>
  );
}
