"use client";

import { use, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { useRouter } from "next/navigation";
import type { KanbanBoardState } from "@platypus/schemas";
import { fetcher, joinUrl } from "@/lib/utils";
import { writeEntity } from "@/lib/api-write";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import { BackButton } from "@/components/back-button";
import { KanbanBoardForm } from "@/components/kanban-board-form";
import { DeleteBoardDialog } from "@/components/delete-board-dialog";
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

    if (result.outcome === "success") {
      result.revalidateKeys.forEach((key) => globalMutate(key));
      router.push(`/${orgId}/workspace/${workspaceId}`);
    } else {
      toast.error(result.message);
      setIsDeleting(false);
      setIsDeleteDialogOpen(false);
    }
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
    <div className="flex justify-center pb-8">
      <div className="w-full px-4 md:px-0 md:w-4/5 xl:w-2/5 space-y-8">
        <BackButton
          fallbackHref={`/${orgId}/workspace/${workspaceId}/boards/${boardId}`}
        />
        <h1 className="text-2xl font-bold">Board Settings</h1>

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
      </div>

      <DeleteBoardDialog
        boardName={data.board.name}
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
        onConfirm={handleDeleteConfirm}
        loading={isDeleting}
      />
    </div>
  );
};

export default BoardSettingsPage;
