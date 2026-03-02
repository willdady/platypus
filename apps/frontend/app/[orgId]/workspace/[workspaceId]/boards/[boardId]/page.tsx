"use client";

import { use } from "react";
import { KanbanBoard } from "@/components/kanban-board";

const BoardPage = ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; boardId: string }>;
}) => {
  const { orgId, workspaceId, boardId } = use(params);

  return (
    <KanbanBoard boardId={boardId} orgId={orgId} workspaceId={workspaceId} />
  );
};

export default BoardPage;
