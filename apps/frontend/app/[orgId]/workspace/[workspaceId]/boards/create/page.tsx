"use client";

import { use } from "react";
import { KanbanBoardForm } from "@/components/kanban-board-form";
import { ResourcePage } from "@/components/resource-page";
import { workspaceRoutes } from "@/lib/routes";

const CreateBoardPage = ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = use(params);

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
