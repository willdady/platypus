"use client";

import { EmptyCard } from "@/components/empty-card";
import { Button } from "@/components/ui/button";
import { Plus, Unplug } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useCanConfigureWorkspaceResource } from "@/hooks/use-can-configure-workspace-resource";
import { workspaceRoutes } from "@/lib/routes";

type NoProvidersEmptyStateProps = {
  orgId: string;
  workspaceId?: string;
  canManage?: boolean;
  action?: ReactNode;
};

export function NoProvidersEmptyState({
  orgId,
  workspaceId,
  canManage,
  action,
}: NoProvidersEmptyStateProps) {
  const canConfigureInWorkspace = useCanConfigureWorkspaceResource("provider");
  const canConfigureProviders =
    canManage ?? (workspaceId ? canConfigureInWorkspace : false);

  const cta =
    action ??
    (canConfigureProviders && workspaceId && (
      <Button asChild className="gap-1">
        <Link href={workspaceRoutes(orgId, workspaceId).settings.providers}>
          <Plus />
          Add provider
        </Link>
      </Button>
    ));

  return (
    <EmptyCard
      icon={<Unplug />}
      title="No providers configured"
      description={
        workspaceId ? (
          <>
            You need to configure at least one AI provider to start using agents
            and chats in this workspace.
            {!canConfigureProviders && " Ask an organization admin to add one."}
          </>
        ) : (
          "Add a provider here, then attach it to the workspaces that should use it."
        )
      }
      action={cta}
    />
  );
}
