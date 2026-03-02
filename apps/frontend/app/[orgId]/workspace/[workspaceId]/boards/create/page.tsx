"use client";

import { use } from "react";
import { KanbanBoardForm } from "@/components/kanban-board-form";
import { BackButton } from "@/components/back-button";

const CreateBoardPage = ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = use(params);

  return (
    <div className="flex justify-center pb-8">
      <div className="xl:w-2/5">
        <BackButton
          fallbackHref={`/${orgId}/workspace/${workspaceId}/boards`}
        />
        <h1 className="text-2xl mb-4 font-bold">New Board</h1>
        <KanbanBoardForm orgId={orgId} workspaceId={workspaceId} />
      </div>
    </div>
  );
};

export default CreateBoardPage;
