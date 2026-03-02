"use client";

import { useState, useCallback, useRef } from "react";
import useSWR from "swr";
import {
  DndContext,
  closestCorners,
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
  KanbanColumn,
} from "@platypus/schemas";
import { fetcher, joinUrl } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import { KanbanColumnComponent } from "@/components/kanban-column";
import { KanbanCardComponent } from "@/components/kanban-card";
import { KanbanCardDialog } from "@/components/kanban-card-dialog";
import { Plus, Settings } from "lucide-react";
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

type ColumnWithCards = KanbanColumn & { cards: KanbanCard[] };

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
    { refreshInterval: 10000 },
  );

  const [localColumns, setLocalColumns] = useState<ColumnWithCards[] | null>(
    null,
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeType, setActiveType] = useState<"column" | "card" | null>(null);
  const [selectedCard, setSelectedCard] = useState<KanbanCard | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  // Add column dialog state
  const [addColumnDialogOpen, setAddColumnDialogOpen] = useState(false);
  const [newColumnName, setNewColumnName] = useState("");

  // Add card dialog state
  const [addCardDialogOpen, setAddCardDialogOpen] = useState(false);
  const [addCardColumnId, setAddCardColumnId] = useState<string | null>(null);
  const [newCardTitle, setNewCardTitle] = useState("");

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

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 5 },
    }),
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
      setLocalColumns([
        ...columns.map((c) => ({ ...c, cards: [...c.cards] })),
      ]);
    },
    [columns],
  );

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const { active, over } = event;
      if (!over || !localColumns || activeType !== "card") return;

      const activeColumn = localColumns.find((col) =>
        col.cards.some((c) => c.id === active.id),
      );
      const overColumn =
        localColumns.find((col) => col.id === over.id) ??
        localColumns.find((col) => col.cards.some((c) => c.id === over.id));

      if (!activeColumn || !overColumn) return;

      // Same column reorder
      if (activeColumn.id === overColumn.id) {
        const activeIndex = activeColumn.cards.findIndex(
          (c) => c.id === active.id,
        );
        const overIndex = overColumn.cards.findIndex((c) => c.id === over.id);
        if (activeIndex !== overIndex && overIndex >= 0) {
          setLocalColumns((prev) => {
            if (!prev) return prev;
            const newCols = prev.map((c) => ({ ...c, cards: [...c.cards] }));
            const col = newCols.find((c) => c.id === activeColumn.id)!;
            const [movedCard] = col.cards.splice(activeIndex, 1);
            col.cards.splice(overIndex, 0, movedCard);
            return newCols;
          });
        }
        return;
      }

      // Cross-column move
      setLocalColumns((prev) => {
        if (!prev) return prev;
        const newCols = prev.map((c) => ({ ...c, cards: [...c.cards] }));
        const fromCol = newCols.find((c) => c.id === activeColumn.id)!;
        const toCol = newCols.find((c) => c.id === overColumn.id)!;
        const cardIndex = fromCol.cards.findIndex((c) => c.id === active.id);
        const [movedCard] = fromCol.cards.splice(cardIndex, 1);
        const overIndex = toCol.cards.findIndex((c) => c.id === over.id);
        if (overIndex >= 0) {
          toCol.cards.splice(overIndex, 0, movedCard);
        } else {
          toCol.cards.push(movedCard);
        }
        return newCols;
      });
    },
    [activeType, localColumns],
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      setActiveId(null);
      setActiveType(null);

      if (!over || !localColumns) {
        setLocalColumns(null);
        return;
      }

      if (active.data.current?.type === "column") {
        const oldIndex = localColumns.findIndex((c) => c.id === active.id);
        const newIndex = localColumns.findIndex((c) => c.id === over.id);
        if (oldIndex !== newIndex) {
          const reordered = arrayMove(localColumns, oldIndex, newIndex);
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
      const column = localColumns.find((col) =>
        col.cards.some((c) => c.id === active.id),
      );
      if (!column) {
        setLocalColumns(null);
        return;
      }

      const cardIndex = column.cards.findIndex((c) => c.id === active.id);
      const afterCardId =
        cardIndex > 0 ? column.cards[cardIndex - 1].id : null;

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
    [localColumns, baseUrl, mutate],
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
    setAddCardDialogOpen(true);
  }, []);

  const confirmAddCard = useCallback(async () => {
    if (!newCardTitle.trim() || !addCardColumnId) return;
    try {
      await fetch(joinUrl(baseUrl, `/columns/${addCardColumnId}/cards`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newCardTitle.trim() }),
        credentials: "include",
      });
      setAddCardDialogOpen(false);
      setNewCardTitle("");
      setAddCardColumnId(null);
      await mutate();
    } catch {
      toast.error("Failed to create card");
    }
  }, [newCardTitle, addCardColumnId, baseUrl, mutate]);

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

  const handleCardSave = useCallback(
    async (
      cardId: string,
      cardData: { title?: string; body?: string; labelIds?: string[] },
    ) => {
      const column = columns.find((col) =>
        col.cards.some((c) => c.id === cardId),
      );
      if (!column) return;
      try {
        await fetch(joinUrl(baseUrl, `/cards/${cardId}`), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(cardData),
          credentials: "include",
        });
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
          <h1 className="text-xl font-bold truncate">{data.board.name}</h1>
        </div>
        <Link
          href={`/${orgId}/workspace/${workspaceId}/boards/${boardId}/settings`}
          className="p-2 hover:bg-muted rounded-md transition-colors shrink-0"
        >
          <Settings className="h-5 w-5 text-muted-foreground" />
        </Link>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
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
              {columns.map((column) => (
                <KanbanColumnComponent
                  key={column.id}
                  column={column}
                  labels={labels}
                  onCardClick={(card) => {
                    setSelectedCard(card);
                    setDialogOpen(true);
                  }}
                  onAddCard={handleAddCard}
                  onEditColumn={handleEditColumn}
                  onDeleteColumn={handleDeleteColumn}
                />
              ))}
            </SortableContext>
            <button
              onClick={handleAddColumn}
              className="flex items-center justify-center w-80 min-w-80 shrink-0 bg-muted/30 rounded-lg border border-dashed border-muted-foreground/30 text-muted-foreground hover:bg-muted/50 transition-colors cursor-pointer"
            >
              <Plus className="h-5 w-5 mr-2" /> Add Column
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
          <div className="py-4">
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
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSave={handleCardSave}
        onDelete={handleCardDelete}
      />
    </div>
  );
}
