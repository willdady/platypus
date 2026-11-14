"use client";

import { use } from "react";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { useEntityDelete } from "@/hooks/use-entity-form";
import { useRouter } from "next/navigation";
import type { KanbanBoard } from "@platypus/schemas";
import { ResourcePage } from "@/components/resource-page";
import { KanbanBoardForm } from "@/components/kanban-board-form";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { workspaceRoutes } from "@/lib/routes";

function BoardSettingsPage({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; boardId: string }>;
}) {
  const { orgId, workspaceId, boardId } = use(params);
  const routes = workspaceRoutes(orgId, workspaceId);
  const router = useRouter();

  // The same key the form reads through, so one request serves both.
  const { data: board } = useScopedSWR<KanbanBoard>(`boards/${boardId}`, {
    orgId,
    workspaceId,
  });

  const { isDeleting, dialogProps, openDeleteDialog } = useEntityDelete({
    entity: "boards",
    scope: { orgId, workspaceId },
    id: boardId,
    successMessage: "Board deleted",
    onSuccess: () => router.push(routes.root),
  });

  return (
    <ResourcePage title="Board Settings" variant="stacked">
      <KanbanBoardForm
        orgId={orgId}
        workspaceId={workspaceId}
        boardId={boardId}
        onDelete={openDeleteDialog}
        isDeleting={isDeleting}
      />

      <DeleteConfirmDialog
        noun="board"
        name={board?.name}
        consequence="This also deletes all of its data."
        requireTypedConfirmation
        {...dialogProps}
      />
    </ResourcePage>
  );
}

export default BoardSettingsPage;
