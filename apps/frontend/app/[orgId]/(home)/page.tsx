"use client";

import { WorkspaceList } from "@/components/workspace-list";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Plus, Settings, FolderClosed } from "lucide-react";
import useSWR from "swr";
import { fetcher, joinUrl } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";
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

export default function OrgPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const backendUrl = useBackendUrl();

  // Fetch workspaces for this org
  const { data: workspacesData, isLoading: isWorkspacesLoading } = useSWR<{
    results: Workspace[];
  }>(
    backendUrl
      ? joinUrl(backendUrl, `/organizations/${orgId}/workspaces`)
      : null,
    fetcher,
  );

  const workspaces = workspacesData?.results || [];

  return (
    <div className="space-y-6">
      {workspaces.length > 0 ? (
        <div className="space-y-4">
          <WorkspaceList orgId={orgId} />
          <div className="flex items-center gap-2">
            <Button asChild>
              <Link href={`/${orgId}/create`}>
                <Plus className="size-4" /> Add workspace
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href={`/${orgId}/settings`}>
                <Settings className="size-4" /> Organization Settings
              </Link>
            </Button>
          </div>
        </div>
      ) : !isWorkspacesLoading ? (
        <Empty className="border-2 border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderClosed />
            </EmptyMedia>
            <EmptyTitle>No workspaces found</EmptyTitle>
            <EmptyDescription>
              Create your first workspace in this organization to start building
              agents.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <div className="flex items-center gap-2">
              <Button asChild className="flex-1">
                <Link href={`/${orgId}/create`}>
                  <Plus className="h-4 w-4" /> Create Workspace
                </Link>
              </Button>
              <Button variant="outline" asChild>
                <Link href={`/${orgId}/settings`}>
                  <Settings className="size-4" /> Organization Settings
                </Link>
              </Button>
            </div>
          </EmptyContent>
        </Empty>
      ) : null}
    </div>
  );
}
