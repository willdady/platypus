"use client";

import {
  useState,
  useCallback,
  useRef,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import {
  DndContext,
  closestCorners,
  closestCenter,
  pointerWithin,
  CollisionDetection,
  DragStartEvent,
  DragEndEvent,
  DragOverlay,
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
} from "@dnd-kit/sortable";
import { motion } from "motion/react";
import { PullToRefresh } from "@/components/pull-to-refresh";
import Link from "next/link";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { toast } from "sonner";
import type {
  KanbanBoardState,
  KanbanCard,
  KanbanCardAssignee,
  KanbanCardPriority,
  KanbanLabel,
} from "@platypus/schemas";
import { cn, joinUrl } from "@/lib/utils";
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
import { Plus, Settings, ChevronDown, KanbanSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { workspaceRoutes } from "@/lib/routes";

const EMPTY_LABELS: KanbanLabel[] = [];

const noop = () => {};

// Module-level so their identity survives re-renders: `useSensor` memoizes on
// the options object, and a fresh literal here rebuilds the sensor list, the
// activators, and every dnd-kit context consumer on every board render.
const POINTER_SENSOR_OPTIONS = {
  activationConstraint: { distance: 5 },
} as const;

const TOUCH_SENSOR_OPTIONS = {
  activationConstraint: { delay: 250, tolerance: 5 },
} as const;

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
  const router = useRouter();
  const pathname = usePathname();

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

  const { data: boardsData } = useScopedSWR<{
    results: { id: string; name: string }[];
  }>("boards", scope);

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
  const [selectedCard, setSelectedCard] = useState<KanbanCard | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  // Add column dialog state
  const [addColumnDialogOpen, setAddColumnDialogOpen] = useState(false);
  const [newColumnName, setNewColumnName] = useState("");

  // Add card dialog state
  const [addCardDialogOpen, setAddCardDialogOpen] = useState(false);
  const [addCardColumnId, setAddCardColumnId] = useState<string | null>(null);
  const [newCardTitle, setNewCardTitle] = useState("");
  const [newCardLabelIds, setNewCardLabelIds] = useState<string[]>([]);

  // Edit column dialog state
  const [editColumnDialogOpen, setEditColumnDialogOpen] = useState(false);
  const [editColumnId, setEditColumnId] = useState<string | null>(null);
  const [editColumnName, setEditColumnName] = useState("");

  // Delete column dialog state
  const [deleteColumnDialogOpen, setDeleteColumnDialogOpen] = useState(false);
  const [deleteColumnId, setDeleteColumnId] = useState<string | null>(null);
  const [deleteColumnHasCards, setDeleteColumnHasCards] = useState(false);

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
  // devices. useSyncExternalStore subscribes to the media query without a
  // setState-in-effect and stays SSR-safe (server snapshot is false).
  const isDesktop = useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia("(pointer: fine)");
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia("(pointer: fine)").matches,
    () => false,
  );

  const updateCardIdParam = useCallback(
    (cardId: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (cardId) {
        params.set("cardId", cardId);
      } else {
        params.delete("cardId");
      }
      const qs = params.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  // Stable across drag frames so the memoized columns and cards it is passed
  // through are not re-rendered on every drag-over update.
  const handleCardClick = useCallback(
    (card: KanbanCard) => {
      setSelectedCard(card);
      setDialogOpen(true);
      updateCardIdParam(card.id);
    },
    [updateCardIdParam],
  );

  // Open card dialog from URL query param on initial data load. Runs once when
  // data first arrives, reads the URL, and may navigate (updateCardIdParam) —
  // genuine effect work, so opening the dialog via setState here is intended.
  const deepLinkHandledRef = useRef(false);
  useEffect(() => {
    if (deepLinkHandledRef.current || !data) return;
    deepLinkHandledRef.current = true;
    const cardId = searchParams.get("cardId");
    if (!cardId) return;
    const card = data.columns
      .flatMap((col) => col.cards)
      .find((c) => c.id === cardId);
    if (card) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedCard(card);
      setDialogOpen(true);
    } else {
      updateCardIdParam(null);
    }
  }, [data, searchParams, updateCardIdParam]);

  const sensors = useSensors(
    useSensor(PointerSensor, POINTER_SENSOR_OPTIONS),
    useSensor(TouchSensor, TOUCH_SENSOR_OPTIONS),
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

  const handleAddColumn = useCallback(() => {
    setNewColumnName("");
    setAddColumnDialogOpen(true);
  }, []);

  const confirmAddColumn = useCallback(async () => {
    if (!newColumnName.trim()) return;
    const outcome = await writeEntity(
      backendUrl,
      `${boardPath}/columns`,
      scope,
      { data: { name: newColumnName.trim() } },
    );
    if (outcome.outcome === "success") {
      setAddColumnDialogOpen(false);
      setNewColumnName("");
      await mutate();
    } else {
      toast.error(outcome.message);
    }
  }, [newColumnName, backendUrl, boardPath, scope, mutate]);

  const handleAddCard = useCallback((columnId: string) => {
    setAddCardColumnId(columnId);
    setNewCardTitle("");
    setNewCardLabelIds([]);
    setAddCardDialogOpen(true);
  }, []);

  const confirmAddCard = useCallback(async () => {
    if (!newCardTitle.trim() || !addCardColumnId) return;
    const outcome = await writeEntity(
      backendUrl,
      `${boardPath}/columns/${addCardColumnId}/cards`,
      scope,
      {
        data: {
          title: newCardTitle.trim(),
          ...(newCardLabelIds.length > 0 && { labelIds: newCardLabelIds }),
        },
      },
    );
    if (outcome.outcome === "success") {
      setAddCardDialogOpen(false);
      setNewCardTitle("");
      setNewCardLabelIds([]);
      setAddCardColumnId(null);
      await mutate();
    } else {
      toast.error(outcome.message);
    }
  }, [
    newCardTitle,
    newCardLabelIds,
    addCardColumnId,
    backendUrl,
    boardPath,
    scope,
    mutate,
  ]);

  const handleEditColumn = useCallback((columnId: string) => {
    const column = columnsRef.current.find((c) => c.id === columnId);
    if (!column) return;
    setEditColumnId(columnId);
    setEditColumnName(column.name);
    setEditColumnDialogOpen(true);
  }, []);

  const confirmEditColumn = useCallback(async () => {
    if (!editColumnName.trim() || !editColumnId) return;
    const outcome = await writeEntity(
      backendUrl,
      `${boardPath}/columns`,
      scope,
      { id: editColumnId, data: { name: editColumnName.trim() } },
    );
    if (outcome.outcome === "success") {
      setEditColumnDialogOpen(false);
      setEditColumnId(null);
      setEditColumnName("");
      await mutate();
    } else {
      toast.error(outcome.message);
    }
  }, [editColumnName, editColumnId, backendUrl, boardPath, scope, mutate]);

  const handleDeleteColumn = useCallback(
    (columnId: string, hasCards: boolean) => {
      setDeleteColumnId(columnId);
      setDeleteColumnHasCards(hasCards);
      setDeleteColumnDialogOpen(true);
    },
    [],
  );

  const confirmDeleteColumn = useCallback(async () => {
    if (!deleteColumnId || deleteColumnHasCards) return;
    const outcome = await writeEntity(
      backendUrl,
      `${boardPath}/columns`,
      scope,
      { id: deleteColumnId },
    );
    if (outcome.outcome === "success") {
      setDeleteColumnDialogOpen(false);
      setDeleteColumnId(null);
      setDeleteColumnHasCards(false);
      await mutate();
    } else {
      toast.error(outcome.message);
    }
  }, [
    deleteColumnId,
    deleteColumnHasCards,
    backendUrl,
    boardPath,
    scope,
    mutate,
  ]);

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
      const closeDialog = () => {
        setDialogOpen(false);
        setSelectedCard(null);
        updateCardIdParam(null);
      };
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
      // A failed move stays open to retry. A conflict closes: the refetch
      // would otherwise reseed the dialog from its stale open-time snapshot.
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
        setDialogOpen(false);
        setSelectedCard(null);
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
    return <div className="p-4 text-destructive">Failed to load board.</div>;
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex items-center gap-2 text-xl font-bold truncate hover:text-muted-foreground transition-colors cursor-pointer min-w-0 max-w-[300px]">
                <span className="truncate">{data.board.name}</span>
                <ChevronDown className="h-4 w-4 shrink-0" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              {boardsData?.results
                .filter((b) => b.id !== boardId)
                .map((board) => (
                  <DropdownMenuItem key={board.id} asChild>
                    <Link
                      href={routes.boards.detail(board.id)}
                      className="flex items-center gap-2 cursor-pointer"
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
                  className="flex items-center gap-2 cursor-pointer"
                >
                  <Plus className="h-4 w-4" />
                  <span>Create new board</span>
                </Link>
              </DropdownMenuItem>
              {(!boardsData?.results ||
                boardsData.results.filter((b) => b.id !== boardId).length ===
                  0) && (
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
                  onAddCard={handleAddCard}
                  onEditColumn={handleEditColumn}
                  onDeleteColumn={handleDeleteColumn}
                  onMoveColumn={handleMoveColumn}
                />
              ))}
            </SortableContext>
            <button
              onClick={handleAddColumn}
              className="flex flex-col items-center justify-center w-40 min-w-40 shrink-0 bg-muted/30 rounded-lg border border-dashed border-muted-foreground/30 text-muted-foreground hover:bg-muted/50 transition-colors cursor-pointer"
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

      {/* Add Column Dialog */}
      <Dialog open={addColumnDialogOpen} onOpenChange={setAddColumnDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Column</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="columnName">Column Name</Label>
            <Input
              id="columnName"
              value={newColumnName}
              onChange={(e) => setNewColumnName(e.target.value)}
              placeholder="Enter column name"
              onKeyDown={(e) => e.key === "Enter" && confirmAddColumn()}
              className="mt-2"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAddColumnDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button onClick={confirmAddColumn}>Add column</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Card Dialog */}
      <Dialog open={addCardDialogOpen} onOpenChange={setAddCardDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Card</DialogTitle>
          </DialogHeader>
          <div className="py-4 space-y-4">
            <div>
              <Label htmlFor="cardTitle">Card Title</Label>
              <Input
                id="cardTitle"
                value={newCardTitle}
                onChange={(e) => setNewCardTitle(e.target.value)}
                placeholder="Enter card title"
                onKeyDown={(e) => e.key === "Enter" && confirmAddCard()}
                className="mt-2"
                autoFocus
              />
            </div>
            {labels.length > 0 && (
              <div>
                <Label>Labels</Label>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {labels.map((label) => {
                    const isActive = newCardLabelIds.includes(label.id);
                    return (
                      <Badge
                        key={label.id}
                        className={cn(
                          "cursor-pointer transition-opacity border-0",
                          !isActive && "opacity-40",
                        )}
                        style={{ backgroundColor: label.color }}
                        onClick={() =>
                          setNewCardLabelIds((prev) =>
                            prev.includes(label.id)
                              ? prev.filter((id) => id !== label.id)
                              : [...prev, label.id],
                          )
                        }
                      >
                        {label.name}
                      </Badge>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAddCardDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button onClick={confirmAddCard}>Add card</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Column Dialog */}
      <Dialog
        open={editColumnDialogOpen}
        onOpenChange={setEditColumnDialogOpen}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Column</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="editColumnName">Column Name</Label>
            <Input
              id="editColumnName"
              value={editColumnName}
              onChange={(e) => setEditColumnName(e.target.value)}
              placeholder="Enter column name"
              onKeyDown={(e) => e.key === "Enter" && confirmEditColumn()}
              className="mt-2"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditColumnDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button onClick={confirmEditColumn}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Column Confirmation Dialog */}
      <Dialog
        open={deleteColumnDialogOpen}
        onOpenChange={setDeleteColumnDialogOpen}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Column</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            {deleteColumnHasCards ? (
              <p className="text-muted-foreground">
                Cannot delete this column because it contains cards. Move or
                delete all cards first.
              </p>
            ) : (
              <p className="text-muted-foreground">
                Are you sure you want to delete this column? This action cannot
                be undone.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteColumnDialogOpen(false)}
            >
              {deleteColumnHasCards ? "Close" : "Cancel"}
            </Button>
            {!deleteColumnHasCards && (
              <Button variant="destructive" onClick={confirmDeleteColumn}>
                Delete
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            setSelectedCard(null);
            updateCardIdParam(null);
          }
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
