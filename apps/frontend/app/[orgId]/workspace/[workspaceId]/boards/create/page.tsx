"use client";

import { use } from "react";
import { KanbanBoardForm } from "@/components/kanban-board-form";
import { ResourcePage } from "@/components/resource-page";

const CreateBoardPage = ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = use(params);

  return (
    <ResourcePage
      backFallbackHref={`/${orgId}/workspace/${workspaceId}/boards`}
      title="New Board"
      variant="create"
    >
      <KanbanBoardForm orgId={orgId} workspaceId={workspaceId} />
    </ResourcePage>
  );
};

export default CreateBoardPage;
