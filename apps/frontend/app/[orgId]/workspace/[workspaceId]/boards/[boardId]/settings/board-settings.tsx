"use client";

import { use } from "react";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { useEntityDelete } from "@/hooks/use-entity-form";
import { useRouter } from "next/navigation";
import type { KanbanBoard } from "@platypus/schemas";
import { ResourcePage } from "@/components/resource-page";
import { KanbanBoardForm } from "@/components/kanban-board-form";
import { EntityDeleteDialog } from "@/components/entity-delete-dialog";
import { workspaceRoutes } from "@/lib/routes";

const BoardSettingsPage = ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; boardId: string }>;
}) => {
  const { orgId, workspaceId, boardId } = use(params);
  const routes = workspaceRoutes(orgId, workspaceId);
  const router = useRouter();

  // The same key the form reads through, so one request serves both.
  const { data: board } = useScopedSWR<KanbanBoard>(`boards/${boardId}`, {
    orgId,
    workspaceId,
  });

  const {
    isDeleteDialogOpen,
    setIsDeleteDialogOpen,
    isDeleting,
    deleteError,
    openDeleteDialog,
    handleDelete,
  } = useEntityDelete({
    entity: "boards",
    scope: { orgId, workspaceId },
    id: boardId,
    onSuccess: () => router.push(routes.root),
  });

  return (
    <ResourcePage
      backFallbackHref={routes.boards.detail(boardId)}
      title="Board Settings"
      variant="stacked"
    >
      <KanbanBoardForm
        orgId={orgId}
        workspaceId={workspaceId}
        boardId={boardId}
        onDelete={openDeleteDialog}
        isDeleting={isDeleting}
      />

      <EntityDeleteDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
        title="Delete Board"
        description={
          <>
            This action cannot be undone. This will permanently delete the board{" "}
            <span className="font-semibold">{board?.name}</span> and all of its
            data.
          </>
        }
        confirmPhrase="delete board"
        onConfirm={handleDelete}
        loading={isDeleting}
        error={deleteError}
      />
    </ResourcePage>
  );
};

export default BoardSettingsPage;
