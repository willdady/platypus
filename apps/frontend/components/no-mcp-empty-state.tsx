import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Button } from "@/components/ui/button";
import { Wrench, Plus } from "lucide-react";
import Link from "next/link";

interface NoMcpEmptyStateProps {
  orgId: string;
  workspaceId: string;
  /** When false, hide the create CTA (caller lacks permission — ADR-0006). */
  canManage?: boolean;
}

export const NoMcpEmptyState = ({
  orgId,
  workspaceId,
  canManage = true,
}: NoMcpEmptyStateProps) => {
  return (
    <Empty className="border-2 border-dashed">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Wrench className="size-6" />
        </EmptyMedia>
        <EmptyTitle>No MCP servers configured</EmptyTitle>
        <EmptyDescription>
          There are currently no MCP servers configured for this workspace.
          {!canManage && " Ask an organization admin to add one."}
        </EmptyDescription>
      </EmptyHeader>
      {canManage && (
        <EmptyContent>
          <Button asChild>
            <Link
              href={`/${orgId}/workspace/${workspaceId}/settings/mcp/create`}
            >
              <Plus /> Add MCP
            </Link>
          </Button>
        </EmptyContent>
      )}
    </Empty>
  );
};
