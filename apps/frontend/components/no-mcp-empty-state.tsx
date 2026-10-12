import { EmptyCard } from "@/components/empty-card";
import { Button } from "@/components/ui/button";
import { Wrench, Plus } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { workspaceRoutes } from "@/lib/routes";

interface NoMcpEmptyStateProps {
  orgId: string;
  /** Absent on the Organization's own settings page, which always passes `action`. */
  workspaceId?: string;
  /** When false, hide the create CTA (caller lacks permission — ADR-0006). */
  canManage?: boolean;
  /** Replaces the default CTA, e.g. the settings list's own Add / Attach buttons. */
  action?: ReactNode;
}

export const NoMcpEmptyState = ({
  orgId,
  workspaceId,
  canManage = true,
  action,
}: NoMcpEmptyStateProps) => {
  const cta =
    action ??
    (canManage && workspaceId && (
      <Button asChild>
        <Link href={workspaceRoutes(orgId, workspaceId).settings.createMcp}>
          <Plus /> Add MCP server
        </Link>
      </Button>
    ));

  return (
    <EmptyCard
      icon={<Wrench />}
      title="No MCP servers configured"
      description={
        workspaceId ? (
          <>
            Add an MCP server to give the agents in this workspace its tools.
            {!canManage && " Ask an organization admin to add one."}
          </>
        ) : (
          "Add an MCP server here, then attach it to the workspaces that should use it."
        )
      }
      action={cta}
    />
  );
};
