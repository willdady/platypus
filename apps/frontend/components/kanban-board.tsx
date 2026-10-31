"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useBoardDrag } from "@/hooks/use-board-drag";
import { useMutation } from "@/hooks/use-mutation";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { useScopedList } from "@/hooks/use-scoped-list";
import { DndContext, DragOverlay } from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
} from "@dnd-kit/sortable";
import { motion } from "motion/react";
import { PullToRefresh } from "@/components/pull-to-refresh";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import type {
  KanbanBoardState,
  KanbanCard,
  KanbanCardAssignee,
  KanbanCardPriority,
  KanbanLabel,
} from "@platypus/schemas";
import {
  scopedUrl,
  writeEntity,
  type Scope,
  type Serialized,
} from "@/lib/api-write";
import { moveCard, type ColumnWithCards } from "@/lib/board-moves";
import { useBackendUrl } from "@/components/auth-provider";
import { KanbanColumnComponent } from "@/components/kanban-column";
import { KanbanCardComponent } from "@/components/kanban-card";
import { KanbanCardDialog } from "@/components/kanban-card-dialog";
import {
  AddCardDialog,
  AddColumnDialog,
  EditColumnDialog,
} from "@/components/kanban-board-dialogs";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { Plus, Settings, ChevronDown, KanbanSquare } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { workspaceRoutes } from "@/lib/routes";
import { replaceSearchParam } from "@/lib/search-params";

const EMPTY_LABELS: KanbanLabel[] = [];
// Shared, so an absent board state doesn't hand the drag hook a fresh array
// each render and reset the optimistic copy.
const EMPTY_COLUMNS: ColumnWithCards[] = [];

type BoardDialog =
  | { kind: "addColumn" }
  | { kind: "addCard"; columnId: string }
  | { kind: "editColumn"; columnId: string; name: string }
  | { kind: "deleteColumn"; columnId: string; hasCards: boolean }
  | null;

function noop() {}

const FINE_POINTER_QUERY = "(pointer: fine)";

// dnd-kit's default instructions offer Enter to pick up, which here opens the
// card instead.
const DND_ACCESSIBILITY = {
  screenReaderInstructions: {
    draggable:
      "To move this item, press space to pick it up, use the arrow keys to move it, then press space again to drop it, or escape to cancel. On a card, press enter to open it.",
  },
};

export function KanbanBoard({
  boardId,
  orgId,
  workspaceId,
}: {
  boardId: string;
  orgId: string;
  workspaceId: string;
}) {
  const backendUrl = useBackendUrl();
  const routes = useMemo(
    () => workspaceRoutes(orgId, workspaceId),
    [orgId, workspaceId],
  );
  const searchParams = useSearchParams();

  const scope: Scope = useMemo(
    () => ({ orgId, workspaceId }),
    [orgId, workspaceId],
  );
  const boardPath = `boards/${boardId}`;
  const baseUrl = scopedUrl(backendUrl, boardPath, scope);

  const { data, error, mutate } = useScopedSWR<KanbanBoardState>(
    `${boardPath}/state`,
    scope,
    { refreshInterval: 10000, refreshWhenHidden: false },
  );

  const { results: boards } = useScopedList<{ id: string; name: string }>(
    "boards",
    scope,
  );

  const {
    columns,
    columnsRef,
    sync,
    activeId,
    activeType,
    activeCard,
    activeColumn,
    columnIds,
    sensors,
    collisionDetection,
    onDragStart,
    onDragOver,
    onDragEnd,
    moveColumn,
  } = useBoardDrag({
    serverColumns: data?.columns ?? EMPTY_COLUMNS,
    boardUrl: baseUrl,
    refetch: mutate,
  });

  // Detect desktop via pointer: fine media query to disable drag on touch
  // devices.
  const isDesktop = useMediaQuery(FINE_POINTER_QUERY);

  // The one board dialog that is open, with what it acts on.
  const [dialog, setDialog] = useState<BoardDialog>(null);
  // A refused column delete, shown inline in its dialog rather than toasted.
  const [deleteColumnError, setDeleteColumnError] = useState<string | null>(
    null,
  );

  const labels = data?.board.labels ?? EMPTY_LABELS;

  // The `?cardId` param is the one record of which card is open: clicking a
  // card writes it, closing clears it, and a shared link arrives with it. The
  // card itself is looked up from the polled columns on every render, so the
  // open dialog always shows the board's latest copy.
  const updateCardIdParam = useCallback(
    (cardId: string | null) => replaceSearchParam("cardId", cardId),
    [],
  );

  const openCardId = searchParams.get("cardId");
  const selectedCard = useMemo(
    () =>
      openCardId
        ? (columns
            .flatMap((col) => col.cards)
            .find((c) => c.id === openCardId) ?? null)
        : null,
    [columns, openCardId],
  );

  // A link to a card the board no longer has opens nothing; drop the param so
  // the URL doesn't keep claiming a card is open.
  useEffect(() => {
    if (data && openCardId && !selectedCard) updateCardIdParam(null);
  }, [data, openCardId, selectedCard, updateCardIdParam]);

  // Stable across drag frames so the memoized columns and cards it is passed
  // through are not re-rendered on every drag-over update.
  const handleCardClick = useCallback(
    (card: Serialized<KanbanCard>) => updateCardIdParam(card.id),
    [updateCardIdParam],
  );

  const closeDialog = useCallback(() => {
    setDeleteColumnError(null);
    setDialog(null);
  }, []);

  /** Sends a dialog's write under the board; closes the dialog once it lands. */
  const submitDialogWrite = async (
    path: string,
    body: Parameters<typeof writeEntity>[3],
    onError?: (message: string) => void,
  ) => {
    const outcome = await writeEntity(
      backendUrl,
      `${boardPath}/${path}`,
      scope,
      body,
    );
    if (outcome.outcome === "success") {
      setDialog(null);
      await mutate();
    } else if (onError) {
      onError(outcome.message);
    } else {
      toast.error(outcome.message);
    }
  };

  const submitAddColumn = (data: { name: string }) =>
    submitDialogWrite("columns", { data });

  const submitAddCard = (
    columnId: string,
    { title, labelIds }: { title: string; labelIds: string[] },
  ) =>
    submitDialogWrite(`columns/${columnId}/cards`, {
      data: { title, ...(labelIds.length > 0 && { labelIds }) },
    });

  const submitEditColumn = (columnId: string, data: { name: string }) =>
    submitDialogWrite("columns", { id: columnId, data });

  // The delete runs once per confirm: a double click would send it twice. A
  // refused delete is shown in the dialog, not toasted, so the reader can act
  // on it there — the same rule every other delete follows.
  const deleteColumn = useMutation((columnId: string) =>
    submitDialogWrite("columns", { id: columnId }, setDeleteColumnError),
  );

  const openAddCard = useCallback(
    (columnId: string) => setDialog({ kind: "addCard", columnId }),
    [],
  );

  const openEditColumn = useCallback(
    (columnId: string) => {
      const column = columnsRef.current.find((c) => c.id === columnId);
      if (!column) return;
      setDialog({ kind: "editColumn", columnId, name: column.name });
    },
    [columnsRef],
  );

  const openDeleteColumn = useCallback(
    (columnId: string, hasCards: boolean) => {
      setDeleteColumnError(null);
      setDialog({ kind: "deleteColumn", columnId, hasCards });
    },
    [],
  );

  const handleCardSave = useCallback(
    async (
      cardId: string,
      cardData: {
        title?: string;
        body?: string;
        labelIds?: string[];
        columnId?: string;
        assignees?: KanbanCardAssignee[];
        dueDate?: string | null;
        priority?: KanbanCardPriority;
      },
    ) => {
      const column = columns.find((col) =>
        col.cards.some((c) => c.id === cardId),
      );
      if (!column) return;
      const { columnId: targetColumnId, ...updateData } = cardData;
      // Fields first: moving first would, on a failed update, reseed the
      // dialog from the new column and wipe the user's unsaved edits.
      const updateOutcome = await writeEntity(
        backendUrl,
        `${boardPath}/cards`,
        scope,
        { id: cardId, data: updateData },
      );
      if (updateOutcome.outcome !== "success") {
        toast.error(updateOutcome.message);
        return;
      }
      const closeDialog = () => updateCardIdParam(null);
      if (!targetColumnId || targetColumnId === column.id) {
        closeDialog();
        await mutate();
        return;
      }
      const result = await moveCard(
        baseUrl,
        {
          cardId,
          columnId: targetColumnId,
          afterCardId: null,
          expectedColumnId: column.id,
        },
        sync,
      );
      if (result.outcome !== "moved") {
        toast.error(
          `Your changes were saved, but the card was not moved. ${result.message}`,
        );
      }
      // A failed move stays open to retry. A conflict closes: the card has
      // moved on elsewhere, so there is nothing left to retry.
      if (result.outcome !== "failed") closeDialog();
    },
    [
      columns,
      backendUrl,
      baseUrl,
      boardPath,
      scope,
      mutate,
      sync,
      updateCardIdParam,
    ],
  );

  const handleCardDelete = useCallback(
    async (cardId: string) => {
      const column = columns.find((col) =>
        col.cards.some((c) => c.id === cardId),
      );
      if (!column) return;
      const outcome = await writeEntity(
        backendUrl,
        `${boardPath}/cards`,
        scope,
        { id: cardId },
      );
      if (outcome.outcome === "success") {
        updateCardIdParam(null);
        await mutate();
      } else {
        toast.error(outcome.message);
      }
    },
    [columns, backendUrl, boardPath, scope, mutate, updateCardIdParam],
  );

  // Only a cold failure replaces the board: a failed background poll keeps the
  // last good state on screen rather than swapping a loaded board for an error.
  if (error && !data) {
    return (
      <div role="alert" className="p-4 text-destructive">
        Failed to load board.
      </div>
    );
  }
  if (!data) {
    return (
      <div
        className="flex flex-col h-full min-w-0 overflow-hidden"
        aria-label="Loading board"
      >
        <div className="flex items-center justify-between px-4 py-2 border-b shrink-0">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="size-9 rounded-md" />
        </div>
        <div className="flex-1 min-h-0 min-w-0 overflow-x-auto">
          <div className="flex gap-4 p-4 h-full min-w-fit">
            {Array.from({ length: 4 }).map((_, colIndex) => (
              <div
                key={colIndex}
                className="flex flex-col w-80 min-w-80 shrink-0 bg-muted/50 rounded-lg"
              >
                {/* Column header: name + count badge, menu button */}
                <div className="flex items-center justify-between p-3">
                  <Skeleton className="h-6 w-32" />
                  <Skeleton className="size-6 rounded" />
                </div>
                <div className="flex-1 overflow-y-hidden p-2 flex flex-col gap-2 min-h-[100px]">
                  {Array.from({
                    length:
                      colIndex === 0
                        ? 3
                        : colIndex === 1
                          ? 5
                          : colIndex === 2
                            ? 2
                            : 4,
                  }).map((_, cardIndex) => (
                    <Skeleton
                      key={cardIndex}
                      className="h-[46px] w-full rounded-lg"
                    />
                  ))}
                </div>
                {/* "Add card" footer */}
                <div className="p-2">
                  <div className="flex h-9 items-center px-4">
                    <Skeleton className="h-4 w-24" />
                  </div>
                </div>
              </div>
            ))}
            {/* "Add column" tile */}
            <div className="w-40 min-w-40 shrink-0 bg-muted/30 rounded-lg border border-dashed border-muted-foreground/30" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <PullToRefresh
      onRefresh={async () => {
        await mutate();
      }}
      disabled={activeId !== null}
      className="flex flex-col h-full min-w-0 overflow-hidden"
    >
      <div className="flex items-center justify-between px-4 py-2 border-b shrink-0">
        <div className="flex items-center gap-4 min-w-0">
          <h1 className="sr-only">{data.board.name}</h1>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-2 text-xl font-bold truncate hover:text-muted-foreground transition-colors min-w-0 max-w-[300px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="truncate">{data.board.name}</span>
                <ChevronDown className="size-4 shrink-0" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              {boards
                .filter((b) => b.id !== boardId)
                .map((board) => (
                  <DropdownMenuItem key={board.id} asChild>
                    <Link
                      href={routes.boards.detail(board.id)}
                      className="flex items-center gap-2"
                    >
                      <KanbanSquare className="size-4" />
                      <span className="truncate">{board.name}</span>
                    </Link>
                  </DropdownMenuItem>
                ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link
                  href={routes.boards.create}
                  className="flex items-center gap-2"
                >
                  <Plus className="size-4" />
                  <span>Create new board</span>
                </Link>
              </DropdownMenuItem>
              {boards.filter((b) => b.id !== boardId).length === 0 && (
                <div className="px-2 py-4 text-center text-sm text-muted-foreground">
                  No other boards
                </div>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <Link
          href={routes.boards.settings(boardId)}
          aria-label="Board settings"
          className="p-2 hover:bg-muted rounded-md transition-colors shrink-0"
        >
          <Settings className="size-5 text-muted-foreground" />
        </Link>
      </div>
      <DndContext
        accessibility={DND_ACCESSIBILITY}
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
      >
        <div className="flex-1 min-h-0 min-w-0 overflow-x-auto">
          <div className="flex gap-4 p-4 h-full min-w-fit">
            <SortableContext
              items={columnIds}
              strategy={horizontalListSortingStrategy}
            >
              {columns.map((column, index) => (
                <KanbanColumnComponent
                  key={column.id}
                  column={column}
                  labels={labels}
                  draggable={isDesktop}
                  isDraggingColumn={activeType === "column"}
                  isFirst={index === 0}
                  isLast={index === columns.length - 1}
                  onCardClick={handleCardClick}
                  onAddCard={openAddCard}
                  onEditColumn={openEditColumn}
                  onDeleteColumn={openDeleteColumn}
                  onMoveColumn={moveColumn}
                />
              ))}
            </SortableContext>
            <button
              type="button"
              onClick={() => setDialog({ kind: "addColumn" })}
              className="flex flex-col items-center justify-center w-40 min-w-40 shrink-0 bg-muted/30 rounded-lg border border-dashed border-muted-foreground/30 text-muted-foreground hover:bg-muted/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Plus className="size-8" />
              <span className="text-sm">Add column</span>
            </button>
          </div>
        </div>
        <DragOverlay>
          {activeCard && (
            <motion.div
              style={{ rotate: "2deg", scale: 1.04 }}
              className="shadow-lg"
            >
              <KanbanCardComponent
                card={activeCard}
                labels={labels}
                onCardClick={noop}
              />
            </motion.div>
          )}
          {activeColumn && (
            <motion.div
              style={{ rotate: "2deg", scale: 1.04 }}
              className="shadow-lg"
            >
              <KanbanColumnComponent
                column={activeColumn}
                labels={labels}
                draggable={false}
                overlay
                onCardClick={noop}
                onAddCard={noop}
                onEditColumn={noop}
                onDeleteColumn={noop}
              />
            </motion.div>
          )}
        </DragOverlay>
      </DndContext>

      {dialog?.kind === "addColumn" && (
        <AddColumnDialog onSubmit={submitAddColumn} onClose={closeDialog} />
      )}
      {dialog?.kind === "addCard" && (
        <AddCardDialog
          labels={labels}
          onSubmit={(values) => submitAddCard(dialog.columnId, values)}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === "editColumn" && (
        <EditColumnDialog
          initialName={dialog.name}
          onSubmit={(values) => submitEditColumn(dialog.columnId, values)}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === "deleteColumn" && (
        <DeleteConfirmDialog
          open
          onOpenChange={(open) => !open && closeDialog()}
          title="Delete Column"
          description={
            dialog.hasCards
              ? "Cannot delete this column because it contains cards. Move or delete all cards first."
              : "Are you sure you want to delete this column? This action cannot be undone."
          }
          cancelLabel={dialog.hasCards ? "Close" : "Cancel"}
          confirmDisabled={dialog.hasCards}
          onConfirm={() => void deleteColumn.run(dialog.columnId)}
          loading={deleteColumn.pending}
          error={deleteColumnError}
        />
      )}

      {/* Card Details Dialog */}
      <KanbanCardDialog
        card={selectedCard}
        labels={labels}
        columns={columns.map((c) => ({ id: c.id, name: c.name }))}
        columnId={
          selectedCard
            ? (columns.find((col) =>
                col.cards.some((c) => c.id === selectedCard.id),
              )?.id ?? null)
            : null
        }
        open={!!selectedCard}
        onOpenChange={(open) => {
          if (!open) updateCardIdParam(null);
        }}
        onSave={handleCardSave}
        onDelete={handleCardDelete}
        orgId={orgId}
        workspaceId={workspaceId}
        boardId={boardId}
      />
    </PullToRefresh>
  );
}
