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
  /** Absent on the Organization's own settings page, which always passes `action`. */
  workspaceId?: string;
  /**
   * An explicit override. Left unset inside a Workspace, the card derives the
   * answer from the caller's permission to configure Providers there (ADR-0006).
   */
  canManage?: boolean;
  /** Replaces the default CTA, e.g. the settings list's own Add / Attach buttons. */
  action?: ReactNode;
};

export function NoProvidersEmptyState({
  orgId,
  workspaceId,
  canManage,
  action,
}: NoProvidersEmptyStateProps) {
  // Workspace home, a new Chat and Boards show this card without naming a
  // permission, so ask the same rule the sidebar and the settings list ask.
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
