import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Button } from "@/components/ui/button";
import { Settings, Unplug } from "lucide-react";
import Link from "next/link";

interface NoProvidersEmptyStateProps {
  orgId: string;
  workspaceId: string;
}

export const NoProvidersEmptyState = ({
  orgId,
  workspaceId,
}: NoProvidersEmptyStateProps) => {
  return (
    <Empty className="border-2 border-dashed">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Settings className="size-6" />
        </EmptyMedia>
        <EmptyTitle>No providers configured</EmptyTitle>
        <EmptyDescription>
          You need to configure at least one AI provider to start using agents
          and chats in this workspace.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild>
          <Link
            href={`/${orgId}/workspace/${workspaceId}/settings/providers/create`}
          >
            <Unplug /> Add Provider
          </Link>
        </Button>
      </EmptyContent>
    </Empty>
  );
};
