"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import useSWR from "swr";
import {
  DndContext,
  closestCorners,
  closestCenter,
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
import Link from "next/link";
import { toast } from "sonner";
import type {
  KanbanBoardState,
  KanbanCard,
  KanbanCardAssignee,
  KanbanCardPriority,
  KanbanColumn,
} from "@platypus/schemas";
import { cn, fetcher, joinUrl } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
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

type ColumnWithCards = KanbanColumn & { cards: KanbanCard[] };

const DROP_ZONE_PREFIX = "column-drop-";

function parseDropZoneId(id: string): string | null {
  return id.startsWith(DROP_ZONE_PREFIX)
    ? id.slice(DROP_ZONE_PREFIX.length)
    : null;
}

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
  const { user } = useAuth();

  const baseUrl = joinUrl(
    backendUrl,
    `/organizations/${orgId}/workspaces/${workspaceId}/boards/${boardId}`,
  );

  const { data, error, mutate } = useSWR<KanbanBoardState>(
    backendUrl && user ? joinUrl(baseUrl, "/state") : null,
    fetcher,
    { refreshInterval: 10000, refreshWhenHidden: false },
  );

  const { data: boardsData } = useSWR<{
    results: { id: string; name: string }[];
  }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/boards`,
        )
      : null,
    fetcher,
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
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeType, setActiveType] = useState<"column" | "card" | null>(null);
  const activeTypeRef = useRef<"column" | "card" | null>(null);
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

  const columns: ColumnWithCards[] = localColumns ?? data?.columns ?? [];
  const labels = data?.board.labels ?? [];

  const prevDataRef = useRef(data);
  if (data !== prevDataRef.current && !activeId) {
    prevDataRef.current = data;
    if (localColumns) setLocalColumns(null);
  }

  // Detect desktop via pointer: fine media query to disable drag on touch devices
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia("(pointer: fine)");
    setIsDesktop(mql.matches);
    const onChange = () => setIsDesktop(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 5 },
    }),
  );

  const columnIds = columns.map((c) => c.id);
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
      return closestCorners(args);
    },
    [columnIds],
  );

  const findColumnByCardId = useCallback(
    (cardId: string): ColumnWithCards | undefined => {
      return columns.find((col) => col.cards.some((c) => c.id === cardId));
    },
    [columns],
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const { active } = event;
      const type = active.data.current?.type;
      setActiveId(active.id as string);
      setActiveType(type);
      activeTypeRef.current = type;
      setLocalColumns([...columns.map((c) => ({ ...c, cards: [...c.cards] }))]);
    },
    [columns],
  );

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { active, over } = event;
    if (!over || activeTypeRef.current !== "card") return;

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
  }, []);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      setActiveId(null);
      setActiveType(null);
      activeTypeRef.current = null;

      // Read the latest localColumns from the ref to avoid stale closures.
      // React may batch state updates from handleDragOver and handleDragEnd
      // within the same frame, so the closure variable can be outdated.
      const cols = localColumnsRef.current;

      if (!over || !cols) {
        setLocalColumns(null);
        return;
      }

      if (active.data.current?.type === "column") {
        const oldIndex = cols.findIndex((c) => c.id === active.id);
        // over.id may be a column id or a card id within that column
        let newIndex = cols.findIndex((c) => c.id === over.id);
        if (newIndex === -1) {
          newIndex = cols.findIndex((c) =>
            c.cards.some((card) => card.id === over.id),
          );
        }
        if (oldIndex !== newIndex && newIndex !== -1) {
          const reordered = arrayMove(cols, oldIndex, newIndex);
          setLocalColumns(reordered);
          try {
            await fetch(joinUrl(baseUrl, "/columns/reorder"), {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                columnIds: reordered.map((c) => c.id),
              }),
              credentials: "include",
            });
            await mutate();
          } catch {
            toast.error("Failed to move card/column");
            setLocalColumns(null);
          }
        } else {
          setLocalColumns(null);
        }
        return;
      }

      // Card drag end
      const column = cols.find((col) =>
        col.cards.some((c) => c.id === active.id),
      );
      if (!column) {
        setLocalColumns(null);
        return;
      }

      // Determine afterCardId using the drop target rather than the local
      // array order.  During cross-column drags the local state may not
      // reflect the visual order shown by dnd-kit's CSS transforms, so
      // reading the position from the array can produce the wrong value.
      const overId = String(over.id);
      const isDropZone = parseDropZoneId(overId) !== null;
      const otherCards = column.cards.filter((c) => c.id !== active.id);

      let afterCardId: string | null;
      if (isDropZone || otherCards.length === 0) {
        // Dropped on empty area or column has no other cards
        afterCardId =
          otherCards.length > 0 ? otherCards[otherCards.length - 1].id : null;
      } else {
        // Dropped over a specific card – decide whether to go before or
        // after it by comparing the dragged card's current centre-Y with
        // the over card's centre-Y.
        const overIdx = otherCards.findIndex((c) => c.id === over.id);
        if (overIdx === -1) {
          // over card is the active card itself – fall back to array order
          const cardIndex = column.cards.findIndex((c) => c.id === active.id);
          afterCardId = cardIndex > 0 ? column.cards[cardIndex - 1].id : null;
        } else {
          const activeTranslated =
            active.rect.current.translated ?? active.rect.current.initial;
          const activeCenterY = activeTranslated
            ? activeTranslated.top + activeTranslated.height / 2
            : 0;
          const overCenterY = over.rect.top + over.rect.height / 2;
          if (activeCenterY > overCenterY) {
            // Active is below the over card → place after it
            afterCardId = otherCards[overIdx].id;
          } else {
            // Active is above the over card → place before it
            afterCardId = overIdx > 0 ? otherCards[overIdx - 1].id : null;
          }
        }
      }

      // Reorder local state to match the computed position so the UI
      // doesn't flash the wrong order when dnd-kit removes its transforms.
      const columnId = column.id;
      setLocalColumns((prev) => {
        if (!prev) return prev;
        return prev.map((c) => {
          if (c.id !== columnId) return c;
          const cards = [...c.cards];
          const idx = cards.findIndex((card) => card.id === active.id);
          if (idx === -1) return c;
          const [movedCard] = cards.splice(idx, 1);
          if (afterCardId === null) {
            cards.unshift(movedCard);
          } else {
            const afterIdx = cards.findIndex((card) => card.id === afterCardId);
            cards.splice(afterIdx + 1, 0, movedCard);
          }
          return { ...c, cards };
        });
      });

      try {
        await fetch(joinUrl(baseUrl, `/cards/${active.id}/move`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            columnId: column.id,
            afterCardId,
          }),
          credentials: "include",
        });
        await mutate();
      } catch {
        toast.error("Failed to move card/column");
        setLocalColumns(null);
      }
    },
    [baseUrl, mutate],
  );

  const handleAddColumn = useCallback(() => {
    setNewColumnName("");
    setAddColumnDialogOpen(true);
  }, []);

  const confirmAddColumn = useCallback(async () => {
    if (!newColumnName.trim()) return;
    try {
      await fetch(joinUrl(baseUrl, "/columns"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newColumnName.trim() }),
        credentials: "include",
      });
      setAddColumnDialogOpen(false);
      setNewColumnName("");
      await mutate();
    } catch {
      toast.error("Failed to create column");
    }
  }, [newColumnName, baseUrl, mutate]);

  const handleAddCard = useCallback((columnId: string) => {
    setAddCardColumnId(columnId);
    setNewCardTitle("");
    setNewCardLabelIds([]);
    setAddCardDialogOpen(true);
  }, []);

  const confirmAddCard = useCallback(async () => {
    if (!newCardTitle.trim() || !addCardColumnId) return;
    try {
      await fetch(joinUrl(baseUrl, `/columns/${addCardColumnId}/cards`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: newCardTitle.trim(),
          ...(newCardLabelIds.length > 0 && { labelIds: newCardLabelIds }),
        }),
        credentials: "include",
      });
      setAddCardDialogOpen(false);
      setNewCardTitle("");
      setNewCardLabelIds([]);
      setAddCardColumnId(null);
      await mutate();
    } catch {
      toast.error("Failed to create card");
    }
  }, [newCardTitle, newCardLabelIds, addCardColumnId, baseUrl, mutate]);

  const handleEditColumn = useCallback(
    (columnId: string) => {
      const column = columns.find((c) => c.id === columnId);
      if (!column) return;
      setEditColumnId(columnId);
      setEditColumnName(column.name);
      setEditColumnDialogOpen(true);
    },
    [columns],
  );

  const confirmEditColumn = useCallback(async () => {
    if (!editColumnName.trim() || !editColumnId) return;
    try {
      await fetch(joinUrl(baseUrl, `/columns/${editColumnId}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editColumnName.trim() }),
        credentials: "include",
      });
      setEditColumnDialogOpen(false);
      setEditColumnId(null);
      setEditColumnName("");
      await mutate();
    } catch {
      toast.error("Failed to update column");
    }
  }, [editColumnName, editColumnId, baseUrl, mutate]);

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
    try {
      await fetch(joinUrl(baseUrl, `/columns/${deleteColumnId}`), {
        method: "DELETE",
        credentials: "include",
      });
      setDeleteColumnDialogOpen(false);
      setDeleteColumnId(null);
      setDeleteColumnHasCards(false);
      await mutate();
    } catch {
      toast.error("Failed to delete column");
    }
  }, [deleteColumnId, deleteColumnHasCards, baseUrl, mutate]);

  const handleMoveColumn = useCallback(
    async (columnId: string, direction: "left" | "right") => {
      const currentColumns = data?.columns ?? [];
      const index = currentColumns.findIndex((c) => c.id === columnId);
      if (index < 0) return;
      const newIndex = direction === "left" ? index - 1 : index + 1;
      if (newIndex < 0 || newIndex >= currentColumns.length) return;
      const reordered = arrayMove(currentColumns, index, newIndex);
      setLocalColumns(reordered);
      try {
        await fetch(joinUrl(baseUrl, "/columns/reorder"), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            columnIds: reordered.map((c) => c.id),
          }),
          credentials: "include",
        });
        await mutate();
      } catch {
        toast.error("Failed to move column");
        setLocalColumns(null);
      }
    },
    [data?.columns, baseUrl, mutate],
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
      try {
        await fetch(joinUrl(baseUrl, `/cards/${cardId}`), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updateData),
          credentials: "include",
        });
        if (targetColumnId && targetColumnId !== column.id) {
          await fetch(joinUrl(baseUrl, `/cards/${cardId}/move`), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              columnId: targetColumnId,
              afterCardId: null,
            }),
            credentials: "include",
          });
        }
        setDialogOpen(false);
        setSelectedCard(null);
        await mutate();
      } catch {
        toast.error("Failed to update card");
      }
    },
    [columns, baseUrl, mutate],
  );

  const handleCardDelete = useCallback(
    async (cardId: string) => {
      const column = columns.find((col) =>
        col.cards.some((c) => c.id === cardId),
      );
      if (!column) return;
      try {
        await fetch(joinUrl(baseUrl, `/cards/${cardId}`), {
          method: "DELETE",
          credentials: "include",
        });
        setDialogOpen(false);
        setSelectedCard(null);
        await mutate();
      } catch {
        toast.error("Failed to delete card");
      }
    },
    [columns, baseUrl, mutate],
  );

  const activeCard =
    activeType === "card" && activeId
      ? columns.flatMap((c) => c.cards).find((c) => c.id === activeId)
      : null;

  const activeColumn =
    activeType === "column" && activeId
      ? columns.find((c) => c.id === activeId)
      : null;

  if (error) {
    return <div className="p-4 text-destructive">Failed to load board.</div>;
  }
  if (!data) {
    return <div className="p-4">Loading...</div>;
  }

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden">
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
                      href={`/${orgId}/workspace/${workspaceId}/boards/${board.id}`}
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
                  href={`/${orgId}/workspace/${workspaceId}/boards/create`}
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
          href={`/${orgId}/workspace/${workspaceId}/boards/${boardId}/settings`}
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
              items={columns.map((c) => c.id)}
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
                  onCardClick={(card) => {
                    setSelectedCard(card);
                    setDialogOpen(true);
                  }}
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
              <span className="text-sm">Add Column</span>
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
                onClick={() => {}}
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
                onCardClick={() => {}}
                onAddCard={() => {}}
                onEditColumn={() => {}}
                onDeleteColumn={() => {}}
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
            <Button onClick={confirmAddColumn}>Add Column</Button>
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
            <Button onClick={confirmAddCard}>Add Card</Button>
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
        onOpenChange={setDialogOpen}
        onSave={handleCardSave}
        onDelete={handleCardDelete}
        orgId={orgId}
        workspaceId={workspaceId}
        boardId={boardId}
      />
    </div>
  );
}
