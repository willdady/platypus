"use client";

import { use } from "react";
import { ArtifactsList } from "@/components/artifacts-list";
import { PageHeader } from "@/components/page-header";

/**
 * The Workspace's Artifacts. The page is its own screen rather than a section
 * on the Workspace home, so its search, filter and page live in the URL and a
 * link to it can be handed to someone else.
 */
export default function ArtifactsPage({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) {
  const { orgId, workspaceId } = use(params);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 md:px-8">
      <PageHeader
        title="Artifacts"
        description="Documents, diagrams, pages and scripts Agents made in this workspace, most recently changed first."
      />
      <ArtifactsList orgId={orgId} workspaceId={workspaceId} />
    </div>
  );
}
