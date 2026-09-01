"use client";

import { use, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { useRouter } from "next/navigation";
import type { KanbanBoardState } from "@platypus/schemas";
import { fetcher, joinUrl } from "@/lib/utils";
import { writeEntity } from "@/lib/api-write";
import { applyDeleteOutcome } from "@/lib/apply-write-outcome";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import { ResourcePage } from "@/components/resource-page";
import { KanbanBoardForm } from "@/components/kanban-board-form";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { toast } from "sonner";

const BoardSettingsPage = ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; boardId: string }>;
}) => {
  const { orgId, workspaceId, boardId } = use(params);
  const { user } = useAuth();
  const backendUrl = useBackendUrl();
  const router = useRouter();
  const { mutate: globalMutate } = useSWRConfig();
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const baseUrl = joinUrl(
    backendUrl,
    `/organizations/${orgId}/workspaces/${workspaceId}/boards/${boardId}`,
  );

  const { data, error, mutate } = useSWR<KanbanBoardState>(
    backendUrl && user ? joinUrl(baseUrl, "/state") : null,
    fetcher,
  );

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
      onSuccess: () => router.push(`/${orgId}/workspace/${workspaceId}`),
      onError: (message) => {
        toast.error(message);
        setIsDeleting(false);
        setIsDeleteDialogOpen(false);
      },
    });
  };

  if (error) {
    return (
      <div className="text-destructive">Failed to load board settings.</div>
    );
  }
  if (!data) {
    return <div>Loading...</div>;
  }

  return (
    <ResourcePage
      backFallbackHref={`/${orgId}/workspace/${workspaceId}/boards/${boardId}`}
      title="Board Settings"
      variant="settings"
    >
      <KanbanBoardForm
        orgId={orgId}
        workspaceId={workspaceId}
        board={{
          id: data.board.id,
          name: data.board.name,
          description: data.board.description,
          labels: data.board.labels,
        }}
        onDelete={() => setIsDeleteDialogOpen(true)}
        isDeleting={isDeleting}
        onSuccess={() => mutate()}
      />

      <ConfirmDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
        title="Delete Board"
        description={
          <>
            This action cannot be undone. This will permanently delete the board{" "}
            <span className="font-semibold">{data.board.name}</span> and all of
            its data.
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
