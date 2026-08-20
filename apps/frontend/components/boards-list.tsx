"use client";

import { useState } from "react";
import {
  Item,
  ItemTitle,
  ItemActions,
  ItemDescription,
  ItemContent,
} from "@/components/ui/item";
import { Button } from "@/components/ui/button";
import { DeleteBoardDialog } from "@/components/delete-board-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EllipsisVertical, Pencil, Trash2 } from "lucide-react";
import { type KanbanBoard } from "@platypus/schemas";
import useSWR from "swr";
import { fetcher, joinUrl } from "@/lib/utils";
import { writeEntity } from "@/lib/api-write";
import Link from "next/link";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";

export const BoardsList = ({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) => {
  const { user } = useAuth();
  const backendUrl = useBackendUrl();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [boardToDelete, setBoardToDelete] = useState<KanbanBoard | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const {
    data: boardsData,
    isLoading,
    mutate,
  } = useSWR<{
    results: KanbanBoard[];
  }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/boards`,
        )
      : null,
    fetcher,
  );

  const boards = [...(boardsData?.results || [])].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  const handleDeleteClick = (board: KanbanBoard) => {
    setBoardToDelete(board);
    setDeleteError(null);
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!boardToDelete || !backendUrl) return;

    setDeleting(true);
    setDeleteError(null);
    try {
      const outcome = await writeEntity(
        backendUrl,
        "boards",
        { orgId, workspaceId },
        { id: boardToDelete.id },
      );
      if (outcome.outcome === "success") {
        mutate();
        setDeleteDialogOpen(false);
        setBoardToDelete(null);
      } else {
        setDeleteError(outcome.message);
      }
    } finally {
      setDeleting(false);
    }
  };

  if (isLoading) {
    return <div>Loading...</div>;
  }

  if (!boards.length) {
    return null;
  }

  return (
    <>
      <ul className="grid grid-cols-1 lg:grid-cols-2 grid-rows-1 gap-2 lg:gap-4">
        {boards.map((board) => (
          <li key={board.id}>
            <Item variant="outline" className="h-full cursor-pointer" asChild>
              <Link
                href={`/${orgId}/workspace/${workspaceId}/boards/${board.id}`}
              >
                <ItemContent>
                  <ItemTitle>{board.name}</ItemTitle>
                  {board.description && (
                    <ItemDescription className="text-xs line-clamp-2">
                      {board.description}
                    </ItemDescription>
                  )}
                </ItemContent>
                <ItemActions>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        className="cursor-pointer text-muted-foreground"
                        variant="ghost"
                        size="icon"
                        onClick={(e) => e.preventDefault()}
                      >
                        <EllipsisVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuItem className="cursor-pointer" asChild>
                        <Link
                          href={`/${orgId}/workspace/${workspaceId}/boards/${board.id}/settings`}
                        >
                          <Pencil /> Edit
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="cursor-pointer text-destructive focus:text-destructive"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleDeleteClick(board);
                        }}
                      >
                        <Trash2 /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </ItemActions>
              </Link>
            </Item>
          </li>
        ))}
      </ul>

      <DeleteBoardDialog
        boardName={boardToDelete?.name ?? ""}
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={handleDeleteConfirm}
        loading={deleting}
        error={deleteError}
      />
    </>
  );
};
