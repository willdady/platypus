import { EmptyCard } from "@/components/empty-card";
import { Button } from "@/components/ui/button";
import { Plus, Unplug } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { workspaceRoutes } from "@/lib/routes";

interface NoProvidersEmptyStateProps {
  orgId: string;
  /** Absent on the Organization's own settings page, which always passes `action`. */
  workspaceId?: string;
  /** When false, hide the create CTA (caller lacks permission — ADR-0006). */
  canManage?: boolean;
  /** Replaces the default CTA, e.g. the settings list's own Add / Attach buttons. */
  action?: ReactNode;
}

export const NoProvidersEmptyState = ({
  orgId,
  workspaceId,
  canManage = true,
  action,
}: NoProvidersEmptyStateProps) => {
  const cta =
    action ??
    (canManage && workspaceId && (
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
            {!canManage && " Ask an organization admin to add one."}
          </>
        ) : (
          "Add a provider here, then attach it to the workspaces that should use it."
        )
      }
      action={cta}
    />
  );
};
