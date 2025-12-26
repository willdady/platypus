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
}

export const NoMcpEmptyState = ({
  orgId,
  workspaceId,
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
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild>
          <Link href={`/${orgId}/workspace/${workspaceId}/settings/mcp/create`}>
            <Plus /> Add MCP
          </Link>
        </Button>
      </EmptyContent>
    </Empty>
  );
};
