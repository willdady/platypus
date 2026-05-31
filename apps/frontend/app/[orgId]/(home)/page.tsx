"use client";

import { WorkspaceList } from "@/components/workspace-list";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Plus, Settings, FolderClosed } from "lucide-react";
import useSWR from "swr";
import { fetcher, joinUrl } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
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
  const { user, isOrgAdmin } = useAuth();

  const { data: workspacesData } = useSWR<{
    results: Workspace[];
  }>(
    backendUrl && user
      ? joinUrl(backendUrl, `/organizations/${orgId}/workspaces`)
      : null,
    fetcher,
  );

  const isReady = !!workspacesData;
  const workspaces = workspacesData?.results || [];

  return (
    <div className="space-y-6">
      {!isReady ? (
        <WorkspaceList orgId={orgId} />
      ) : workspaces.length > 0 ? (
        <div className="space-y-4">
          <WorkspaceList orgId={orgId} />
          <div className="flex items-center gap-2">
            {/* ADR-0008: Workspace creation is org-admin-only. */}
            {isOrgAdmin && (
              <Button asChild>
                <Link href={`/${orgId}/create`}>
                  <Plus className="size-4" /> Add workspace
                </Link>
              </Button>
            )}
            <Button variant="outline" asChild>
              <Link href={`/${orgId}/settings`}>
                <Settings className="size-4" /> Organization Settings
              </Link>
            </Button>
          </div>
        </div>
      ) : (
        <Empty className="border-2 border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderClosed />
            </EmptyMedia>
            <EmptyTitle>No workspaces found</EmptyTitle>
            <EmptyDescription>
              {isOrgAdmin
                ? "Create your first workspace in this organization to start building agents."
                : "You don't have a workspace yet. An organization admin can provision one for you."}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <div className="flex items-center gap-2">
              {/* ADR-0008: Workspace creation is org-admin-only. */}
              {isOrgAdmin && (
                <Button asChild className="flex-1">
                  <Link href={`/${orgId}/create`}>
                    <Plus className="h-4 w-4" /> Create Workspace
                  </Link>
                </Button>
              )}
              <Button variant="outline" asChild>
                <Link href={`/${orgId}/settings`}>
                  <Settings className="size-4" /> Organization Settings
                </Link>
              </Button>
            </div>
          </EmptyContent>
        </Empty>
      )}
    </div>
  );
}
