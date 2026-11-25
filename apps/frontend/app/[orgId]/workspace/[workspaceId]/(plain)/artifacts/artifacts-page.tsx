"use client";

import { use } from "react";
import { ArtifactsList } from "@/components/artifacts-list";
import { PageHeader } from "@/components/page-header";

export default function ArtifactsPage({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) {
  const { orgId, workspaceId } = use(params);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 md:px-8">
      <PageHeader
        title="Artifacts"
        description="Documents, diagrams, pages and scripts Agents made in this workspace, most recently changed first."
      />
      <div className="flex flex-col gap-4">
        <ArtifactsList orgId={orgId} workspaceId={workspaceId} />
      </div>
    </div>
  );
}
