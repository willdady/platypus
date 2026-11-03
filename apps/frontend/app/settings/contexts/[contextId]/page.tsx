import type { Metadata } from "next";
import { WorkspaceContextForm } from "@/components/workspace-context-form";
import { ResourcePage } from "@/components/resource-page";

export const metadata: Metadata = { title: "Edit Workspace Context" };

async function WorkspaceContextEditPage({
  params,
}: {
  params: Promise<{ contextId: string }>;
}) {
  const { contextId } = await params;

  return (
    <ResourcePage title="Edit Workspace Context">
      <WorkspaceContextForm contextId={contextId} />
    </ResourcePage>
  );
}

export default WorkspaceContextEditPage;
