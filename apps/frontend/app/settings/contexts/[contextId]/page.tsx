import type { Metadata } from "next";
import { WorkspaceContextForm } from "@/components/workspace-context-form";
import { ResourcePage } from "@/components/resource-page";
import { userRoutes } from "@/lib/routes";

export const metadata: Metadata = { title: "Edit Workspace Context" };

async function WorkspaceContextEditPage({
  params,
}: {
  params: Promise<{ contextId: string }>;
}) {
  const { contextId } = await params;

  return (
    <ResourcePage
      backFallbackHref={userRoutes.contexts}
      title="Edit Workspace Context"
    >
      <WorkspaceContextForm contextId={contextId} />
    </ResourcePage>
  );
}

export default WorkspaceContextEditPage;
