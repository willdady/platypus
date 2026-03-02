"use client";

import { use, useState } from "react";
import useSWR from "swr";
import { useRouter } from "next/navigation";
import type { KanbanBoardState } from "@platypus/schemas";
import { fetcher, joinUrl } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import { BackButton } from "@/components/back-button";
import { KanbanBoardForm } from "@/components/kanban-board-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const BoardSettingsPage = ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; boardId: string }>;
}) => {
  const { orgId, workspaceId, boardId } = use(params);
  const { user } = useAuth();
  const backendUrl = useBackendUrl();
  const router = useRouter();
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
    try {
      await fetch(baseUrl, { method: "DELETE", credentials: "include" });
      router.push(`/${orgId}/workspace/${workspaceId}/boards`);
    } catch (err) {
      console.error("Failed to delete board:", err);
      setIsDeleting(false);
      setIsDeleteDialogOpen(false);
    }
  };

  if (error) {
    return <div className="text-destructive">Failed to load board settings.</div>;
  }
  if (!data) {
    return <div>Loading...</div>;
  }

  return (
    <div className="flex justify-center pb-8">
      <div className="w-full max-w-2xl space-y-8">
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

      <Dialog
        open={isDeleteDialogOpen}
        onOpenChange={(open) => {
          if (!isDeleting) setIsDeleteDialogOpen(open);
        }}
      >
        <DialogContent
          onPointerDownOutside={(e) => {
            if (isDeleting) e.preventDefault();
          }}
          onEscapeKeyDown={(e) => {
            if (isDeleting) e.preventDefault();
          }}
          showCloseButton={false}
        >
          <DialogHeader>
            <DialogTitle>Delete Board</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this board? This action cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsDeleteDialogOpen(false)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteConfirm}
              disabled={isDeleting}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default BoardSettingsPage;
