import type { Metadata } from "next";
import { KanbanBoardForm } from "@/components/kanban-board-form";
import { ResourcePage } from "@/components/resource-page";

export const metadata: Metadata = { title: "New Board" };

async function CreateBoardPage({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) {
  const { orgId, workspaceId } = await params;

  return (
    <ResourcePage title="New Board" variant="narrow">
      <KanbanBoardForm orgId={orgId} workspaceId={workspaceId} />
    </ResourcePage>
  );
}

export default CreateBoardPage;
