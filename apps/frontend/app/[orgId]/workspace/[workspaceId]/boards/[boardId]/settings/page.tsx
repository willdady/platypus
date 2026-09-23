"use client";

import { use, useState } from "react";
import { useSWRConfig } from "swr";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { useRouter } from "next/navigation";
import type { KanbanBoard } from "@platypus/schemas";
import { writeEntity } from "@/lib/api-write";
import { applyDeleteOutcome } from "@/lib/apply-write-outcome";
import { useBackendUrl } from "@/components/auth-provider";
import { ResourcePage } from "@/components/resource-page";
import { KanbanBoardForm } from "@/components/kanban-board-form";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { toast } from "sonner";
import { workspaceRoutes } from "@/lib/routes";

const BoardSettingsPage = ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; boardId: string }>;
}) => {
  const { orgId, workspaceId, boardId } = use(params);
  const routes = workspaceRoutes(orgId, workspaceId);
  const backendUrl = useBackendUrl();
  const router = useRouter();
  const { mutate: globalMutate } = useSWRConfig();
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // The same key the form reads through, so one request serves both.
  const { data: board } = useScopedSWR<KanbanBoard>(`boards/${boardId}`, {
    orgId,
    workspaceId,
  });

  const handleDeleteConfirm = async () => {
    setIsDeleting(true);
    const result = await writeEntity(
      backendUrl,
      "boards",
      { orgId, workspaceId },
      { id: boardId },
    );

    await applyDeleteOutcome(result, {
      mutate: globalMutate,
      onSuccess: () => router.push(routes.root),
      onError: (message) => {
        toast.error(message);
        setIsDeleting(false);
        setIsDeleteDialogOpen(false);
      },
    });
  };

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
        onDelete={() => setIsDeleteDialogOpen(true)}
        isDeleting={isDeleting}
      />

      <ConfirmDialog
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
        confirmLabel="Delete"
        confirmVariant="destructive"
        confirmPhrase="delete board"
        loadingLabel="Deleting..."
        onConfirm={handleDeleteConfirm}
        loading={isDeleting}
      />
    </ResourcePage>
  );
};

export default BoardSettingsPage;
