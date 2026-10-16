import type { Metadata } from "next";
import { KanbanBoardForm } from "@/components/kanban-board-form";
import { ResourcePage } from "@/components/resource-page";
import { workspaceRoutes } from "@/lib/routes";

export const metadata: Metadata = { title: "New Board" };

const CreateBoardPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = await params;

  return (
    <ResourcePage
      backFallbackHref={workspaceRoutes(orgId, workspaceId).boards.root}
      title="New Board"
      variant="narrow"
    >
      <KanbanBoardForm orgId={orgId} workspaceId={workspaceId} />
    </ResourcePage>
  );
};

export default CreateBoardPage;
