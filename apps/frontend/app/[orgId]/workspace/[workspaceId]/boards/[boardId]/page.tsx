import type { Metadata } from "next";
import { KanbanBoard } from "@/components/kanban-board";

export const metadata: Metadata = { title: "Board" };

async function BoardPage({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; boardId: string }>;
}) {
  const { orgId, workspaceId, boardId } = await params;

  return (
    <KanbanBoard boardId={boardId} orgId={orgId} workspaceId={workspaceId} />
  );
}

export default BoardPage;
