"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useMutation } from "@/hooks/use-mutation";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { useScopedList } from "@/hooks/use-scoped-list";
import {
  DndContext,
  closestCorners,
  closestCenter,
  pointerWithin,
  CollisionDetection,
  DragStartEvent,
  DragEndEvent,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  DragOverEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  arrayMove,
  sortableKeyboardCoordinates,
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
import { joinUrl } from "@/lib/utils";
import { writeEntity, type Scope } from "@/lib/api-write";
import {
  applyCardMove,
  moveCard,
  parseDropZoneId,
  placeCard,
  reorderColumns,
  type BoardSync,
  type ColumnWithCards,
} from "@/lib/board-moves";
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

type BoardDialog =
  | { kind: "addColumn" }
  | { kind: "addCard"; columnId: string }
  | { kind: "editColumn"; columnId: string; name: string }
  | { kind: "deleteColumn"; columnId: string; hasCards: boolean }
  | null;

const noop = () => {};

const FINE_POINTER_QUERY = "(pointer: fine)";

// Module-level so their identity survives re-renders: `useSensor` memoizes on
// the options object, and a fresh literal here rebuilds the sensor list, the
// activators, and every dnd-kit context consumer on every board render.
const POINTER_SENSOR_OPTIONS = {
  activationConstraint: { distance: 5 },
} as const;

const TOUCH_SENSOR_OPTIONS = {
  activationConstraint: { delay: 250, tolerance: 5 },
} as const;

// Space alone picks an item up: Enter is a card's "open", as a click is.
const KEYBOARD_SENSOR_OPTIONS = {
  coordinateGetter: sortableKeyboardCoordinates,
  keyboardCodes: {
    start: ["Space"],
    cancel: ["Escape"],
    end: ["Space", "Enter"],
  },
};

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

  const baseUrl = joinUrl(
    backendUrl,
    `/organizations/${orgId}/workspaces/${workspaceId}/boards/${boardId}`,
  );
  const scope: Scope = useMemo(
    () => ({ orgId, workspaceId }),
    [orgId, workspaceId],
  );
  const boardPath = `boards/${boardId}`;

  const { data, error, mutate } = useScopedSWR<KanbanBoardState>(
    `${boardPath}/state`,
    scope,
    { refreshInterval: 10000, refreshWhenHidden: false },
  );

  const { results: boards } = useScopedList<{ id: string; name: string }>(
    "boards",
    scope,
  );

  const [localColumns, _setLocalColumns] = useState<ColumnWithCards[] | null>(
    null,
  );
  const localColumnsRef = useRef<ColumnWithCards[] | null>(null);
  const setLocalColumns = useCallback(
    (
      action:
        | ColumnWithCards[]
        | null
        | ((prev: ColumnWithCards[] | null) => ColumnWithCards[] | null),
    ) => {
      if (typeof action === "function") {
        _setLocalColumns((prev) => {
          const next = action(prev);
          localColumnsRef.current = next;
          return next;
        });
      } else {
        localColumnsRef.current = action;
        _setLocalColumns(action);
      }
    },
    [],
  );
  const sync: BoardSync = useMemo(
    () => ({ setColumns: setLocalColumns, refetch: mutate }),
    [setLocalColumns, mutate],
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeType, setActiveType] = useState<"column" | "card" | null>(null);
  const activeTypeRef = useRef<"column" | "card" | null>(null);
  // Throttle drag-over updates to once per animation frame.  dnd-kit fires
  // onDragOver from a useEffect on overId, so a setLocalColumns inside that
  // handler can shift layout, change overId, re-fire the effect, and loop
  // (React #185).  Coalescing to one update per frame breaks the loop while
  // still letting the user see cards animate as they drag.
  const dragOverFrameRef = useRef<number | null>(null);
  // The column a card drag started from, captured before drag-over rewrites
  // localColumns. Cross-column moves are applied to the local copy while the
  // card is still in flight, so by drag-end the card already sits in its
  // target column locally — reading the source from there would send the
  // target as `expectedColumnId` and refuse every cross-column move.
  const dragOriginColumnRef = useRef<string | null>(null);

  // The one board dialog that is open, with what it acts on.
  const [dialog, setDialog] = useState<BoardDialog>(null);

  const columns: ColumnWithCards[] = useMemo(
    () => localColumns ?? data?.columns ?? [],
    [localColumns, data],
  );
  const labels = data?.board.labels ?? EMPTY_LABELS;

  // Drag handlers run between commits, so an effect-updated ref always holds
  // the columns the last commit rendered. Reading `columns` directly would
  // rebuild the handlers on every drag frame, and every DndContext prop change
  // re-renders its subtree.
  const columnsRef = useRef(columns);
  useEffect(() => {
    columnsRef.current = columns;
  });

  // When fresh server data arrives (and we're not mid-drag), drop the local
  // optimistic copy so the board reflects the server. Uses React's "adjust
  // state during render" pattern (state, not a ref, to avoid reading/writing
  // a ref during render).
  const [prevData, setPrevData] = useState(data);
  if (data !== prevData && !activeId) {
    setPrevData(data);
    // Use the raw state setter here: setLocalColumns writes localColumnsRef,
    // and refs must not be written during render. The ref is re-synced on the
    // next drag start (and only ever read inside drag handlers), so leaving it
    // until then is safe.
    if (localColumns) _setLocalColumns(null);
  }

  // Detect desktop via pointer: fine media query to disable drag on touch
  // devices.
  const isDesktop = useMediaQuery(FINE_POINTER_QUERY);

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
    (card: KanbanCard) => updateCardIdParam(card.id),
    [updateCardIdParam],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, POINTER_SENSOR_OPTIONS),
    useSensor(TouchSensor, TOUCH_SENSOR_OPTIONS),
    useSensor(KeyboardSensor, KEYBOARD_SENSOR_OPTIONS),
  );

  const columnIdsKey = columns.map((c) => c.id).join("\n");
  // Both sortable contexts key off array identity, so rebuilding this array
  // every render makes every card and column re-render. Rebuild it only when
  // the id sequence actually changes.
  const columnIds = useMemo(
    () => (columnIdsKey ? columnIdsKey.split("\n") : []),
    [columnIdsKey],
  );
  const collisionDetection: CollisionDetection = useCallback(
    (args) => {
      if (activeTypeRef.current === "column") {
        // Only consider column sortable containers, ignore cards and card droppables
        const filtered = {
          ...args,
          droppableContainers: args.droppableContainers.filter((container) =>
            columnIds.includes(container.id as string),
          ),
        };
        return closestCenter(filtered);
      }
      // Card drags: pointerWithin gives a stable over-target tied to the
      // cursor, so layout shifts during a cross-column move can't flip the
      // over-target between columns and trigger an update loop.
      const pointerCollisions = pointerWithin(args);
      if (pointerCollisions.length > 0) {
        return pointerCollisions;
      }
      return closestCorners(args);
    },
    [columnIds],
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const { active } = event;
      const type = active.data.current?.type;
      const cols = columnsRef.current;
      setActiveId(active.id as string);
      setActiveType(type);
      activeTypeRef.current = type;
      dragOriginColumnRef.current =
        type === "card"
          ? (cols.find((col) => col.cards.some((c) => c.id === active.id))
              ?.id ?? null)
          : null;
      setLocalColumns([...cols.map((c) => ({ ...c, cards: [...c.cards] }))]);
    },
    [setLocalColumns],
  );

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const { active, over } = event;
      if (!over || activeTypeRef.current !== "card") return;

      // Skip if we already scheduled an update this frame: a previous
      // drag-over already set localColumns, and processing another one before
      // React flushes can re-trigger this handler off the resulting layout
      // shift.
      if (dragOverFrameRef.current !== null) return;

      const cols = localColumnsRef.current;
      if (!cols) return;

      const activeColumn = cols.find((col) =>
        col.cards.some((c) => c.id === active.id),
      );
      const overId = String(over.id);
      const droppableColumnId = parseDropZoneId(overId);
      const overColumn =
        (droppableColumnId
          ? cols.find((col) => col.id === droppableColumnId)
          : null) ??
        cols.find((col) => col.id === over.id) ??
        cols.find((col) => col.cards.some((c) => c.id === over.id));

      if (!activeColumn || !overColumn) return;

      const scheduleNextFrame = () => {
        dragOverFrameRef.current = requestAnimationFrame(() => {
          dragOverFrameRef.current = null;
        });
      };

      // Same column reorder
      if (activeColumn.id === overColumn.id) {
        const activeIndex = activeColumn.cards.findIndex(
          (c) => c.id === active.id,
        );
        const overIndex = overColumn.cards.findIndex((c) => c.id === over.id);
        // overIndex === -1 means hovering over the column drop zone → move to end
        const targetIndex =
          overIndex === -1 ? activeColumn.cards.length - 1 : overIndex;
        if (activeIndex !== targetIndex) {
          scheduleNextFrame();
          setLocalColumns((prev) => {
            if (!prev) return prev;
            return prev.map((c) =>
              c.id === activeColumn.id
                ? { ...c, cards: arrayMove(c.cards, activeIndex, targetIndex) }
                : c,
            );
          });
        }
        return;
      }

      // Cross-column move
      const activeColId = activeColumn.id;
      const overColId = overColumn.id;
      const overCardId = over.id;
      scheduleNextFrame();
      setLocalColumns((prev) => {
        if (!prev) return prev;
        return prev.map((c) => {
          if (c.id === activeColId) {
            return {
              ...c,
              cards: c.cards.filter((card) => card.id !== active.id),
            };
          }
          if (c.id === overColId) {
            const movedCard = activeColumn.cards.find(
              (card) => card.id === active.id,
            );
            if (!movedCard) return c;
            const newCards = [...c.cards];
            const overIndex = newCards.findIndex(
              (card) => card.id === overCardId,
            );
            if (overIndex >= 0) {
              newCards.splice(overIndex, 0, movedCard);
            } else {
              newCards.push(movedCard);
            }
            return { ...c, cards: newCards };
          }
          return c;
        });
      });
    },
    [setLocalColumns],
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      setActiveId(null);
      setActiveType(null);
      activeTypeRef.current = null;
      if (dragOverFrameRef.current !== null) {
        cancelAnimationFrame(dragOverFrameRef.current);
        dragOverFrameRef.current = null;
      }

      // Read the latest localColumns from the ref to avoid stale closures.
      // React may batch state updates from handleDragOver and handleDragEnd
      // within the same frame, so the closure variable can be outdated.
      const cols = localColumnsRef.current;

      if (!over || !cols) {
        setLocalColumns(null);
        return;
      }

      if (active.data.current?.type === "column") {
        const current = columnsRef.current;
        const oldIndex = current.findIndex((c) => c.id === active.id);
        // over.id may be a column id or a card id within that column
        let newIndex = current.findIndex((c) => c.id === over.id);
        if (newIndex === -1) {
          newIndex = current.findIndex((c) =>
            c.cards.some((card) => card.id === over.id),
          );
        }
        if (oldIndex !== newIndex && newIndex !== -1) {
          const result = await reorderColumns(
            baseUrl,
            current,
            oldIndex,
            newIndex,
            sync,
          );
          if (result.outcome === "failed") toast.error(result.message);
        } else {
          setLocalColumns(null);
        }
        return;
      }

      // Card drag end.  Drag-over has already moved the card in the local
      // copy, so `fromColumnId` here is where the card sits *now* — the drag's
      // true origin lives in dragOriginColumnRef.
      const cardId = String(active.id);
      const placement = placeCard(cols, {
        activeId: cardId,
        overId: String(over.id),
        activeRect:
          active.rect.current.translated ?? active.rect.current.initial,
        overRect: over.rect,
      });
      if (!placement) {
        setLocalColumns(null);
        return;
      }
      const { fromColumnId, toColumnId, afterCardId } = placement;

      // Optimistic local update so the UI doesn't flash while the request
      // is in flight.
      setLocalColumns(
        (prev) => prev && applyCardMove(prev, { cardId, ...placement }),
      );

      const result = await moveCard(
        baseUrl,
        {
          cardId,
          columnId: toColumnId,
          afterCardId,
          expectedColumnId: dragOriginColumnRef.current ?? fromColumnId,
        },
        sync,
      );
      if (result.outcome === "conflict") {
        toast.error(`${result.message} Your change was not applied.`);
      } else if (result.outcome === "failed") {
        toast.error(result.message);
      }
    },
    [baseUrl, sync, setLocalColumns],
  );

  const closeDialog = useCallback(() => setDialog(null), []);

  /** Sends a dialog's write under the board; closes the dialog once it lands. */
  const submitDialogWrite = async (
    path: string,
    body: Parameters<typeof writeEntity>[3],
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

  // The delete runs once per confirm: a double click would send it twice.
  const deleteColumn = useMutation((columnId: string) =>
    submitDialogWrite("columns", { id: columnId }),
  );

  const openAddCard = useCallback(
    (columnId: string) => setDialog({ kind: "addCard", columnId }),
    [],
  );

  const openEditColumn = useCallback((columnId: string) => {
    const column = columnsRef.current.find((c) => c.id === columnId);
    if (!column) return;
    setDialog({ kind: "editColumn", columnId, name: column.name });
  }, []);

  const openDeleteColumn = useCallback(
    (columnId: string, hasCards: boolean) =>
      setDialog({ kind: "deleteColumn", columnId, hasCards }),
    [],
  );

  const handleMoveColumn = useCallback(
    async (columnId: string, direction: "left" | "right") => {
      const current = columnsRef.current;
      const index = current.findIndex((c) => c.id === columnId);
      if (index < 0) return;
      const newIndex = direction === "left" ? index - 1 : index + 1;
      if (newIndex < 0 || newIndex >= current.length) return;
      const result = await reorderColumns(
        baseUrl,
        current,
        index,
        newIndex,
        sync,
      );
      if (result.outcome === "failed") toast.error(result.message);
    },
    [baseUrl, sync],
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

  const activeCard =
    activeType === "card" && activeId
      ? columns.flatMap((c) => c.cards).find((c) => c.id === activeId)
      : null;

  const activeColumn =
    activeType === "column" && activeId
      ? columns.find((c) => c.id === activeId)
      : null;

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
                <div className="flex-1 overflow-y-hidden p-2 space-y-2 min-h-[100px]">
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
                <ChevronDown className="h-4 w-4 shrink-0" />
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
                      <KanbanSquare className="h-4 w-4" />
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
                  <Plus className="h-4 w-4" />
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
          <Settings className="h-5 w-5 text-muted-foreground" />
        </Link>
      </div>
      <DndContext
        accessibility={DND_ACCESSIBILITY}
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
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
                  onMoveColumn={handleMoveColumn}
                />
              ))}
            </SortableContext>
            <button
              type="button"
              onClick={() => setDialog({ kind: "addColumn" })}
              className="flex flex-col items-center justify-center w-40 min-w-40 shrink-0 bg-muted/30 rounded-lg border border-dashed border-muted-foreground/30 text-muted-foreground hover:bg-muted/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Plus className="h-8 w-8" />
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
