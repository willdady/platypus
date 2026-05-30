import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Button } from "@/components/ui/button";
import { Plus, Unplug } from "lucide-react";
import Link from "next/link";

interface NoProvidersEmptyStateProps {
  orgId: string;
  workspaceId: string;
  /** When false, hide the create CTA (caller lacks permission — ADR-0006). */
  canManage?: boolean;
}

export const NoProvidersEmptyState = ({
  orgId,
  workspaceId,
  canManage = true,
}: NoProvidersEmptyStateProps) => {
  return (
    <Empty className="border-2 border-dashed">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Unplug className="size-6" />
        </EmptyMedia>
        <EmptyTitle>No providers configured</EmptyTitle>
        <EmptyDescription>
          You need to configure at least one AI provider to start using agents
          and chats in this workspace.
          {!canManage && " Ask an organization admin to add one."}
        </EmptyDescription>
      </EmptyHeader>
      {canManage && (
        <EmptyContent>
          <Button asChild>
            <Link
              href={`/${orgId}/workspace/${workspaceId}/settings/providers/create`}
            >
              <Plus /> Add Provider
            </Link>
          </Button>
        </EmptyContent>
      )}
    </Empty>
  );
};
