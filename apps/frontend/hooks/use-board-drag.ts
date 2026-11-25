"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  closestCenter,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  TouchSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import type { KanbanCard } from "@platypus/schemas";
import type { Serialized } from "@/lib/api-write";
import {
  applyCardMove,
  columnOfCard,
  moveCard,
  placeCard,
  reorderColumns,
  resolveOverColumn,
  type BoardSync,
  type ColumnWithCards,
} from "@/lib/board-moves";

// why: module-level, or a fresh literal rebuilds every sensor and dnd-kit consumer
const POINTER_SENSOR_OPTIONS = {
  activationConstraint: { distance: 5 },
} as const;

const TOUCH_SENSOR_OPTIONS = {
  activationConstraint: { delay: 250, tolerance: 5 },
} as const;

// why: Space alone picks up; Enter opens the card, as a click does
const KEYBOARD_SENSOR_OPTIONS = {
  coordinateGetter: sortableKeyboardCoordinates,
  keyboardCodes: {
    start: ["Space"],
    cancel: ["Escape"],
    end: ["Space", "Enter"],
  },
};

export function useBoardDrag({
  serverColumns,
  boardUrl,
  refetch,
}: {
  serverColumns: ColumnWithCards[];
  boardUrl: string;
  refetch: () => Promise<unknown>;
}) {
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
    () => ({ setColumns: setLocalColumns, refetch }),
    [setLocalColumns, refetch],
  );

  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeType, setActiveType] = useState<"column" | "card" | null>(null);
  const activeTypeRef = useRef<"column" | "card" | null>(null);
  // why: one drag-over a frame; a second before the flush re-loops on the shift (React #185)
  const dragOverFrameRef = useRef<number | null>(null);
  // why: captured before drag-over rewrites the copy, or cross-column moves are refused
  const dragOriginColumnRef = useRef<string | null>(null);

  const columns: ColumnWithCards[] = useMemo(
    () => localColumns ?? serverColumns,
    [localColumns, serverColumns],
  );

  // why: handlers run between commits; reading `columns` rebuilds them every drag frame
  const columnsRef = useRef(columns);
  useEffect(() => {
    columnsRef.current = columns;
  });

  // why: reset during render with the raw setter; refs must not be written in render
  const [prevData, setPrevData] = useState(serverColumns);
  if (serverColumns !== prevData && !activeId) {
    setPrevData(serverColumns);
    if (localColumns) _setLocalColumns(null);
  }

  const sensors = useSensors(
    useSensor(PointerSensor, POINTER_SENSOR_OPTIONS),
    useSensor(TouchSensor, TOUCH_SENSOR_OPTIONS),
    useSensor(KeyboardSensor, KEYBOARD_SENSOR_OPTIONS),
  );

  // why: sortable contexts key off identity; a rebuild re-renders every card
  const columnIdsKey = columns.map((c) => c.id).join("\n");
  const columnIds = useMemo(
    () => (columnIdsKey ? columnIdsKey.split("\n") : []),
    [columnIdsKey],
  );

  const collisionDetection: CollisionDetection = useCallback(
    (args) => {
      if (activeTypeRef.current === "column") {
        const filtered = {
          ...args,
          droppableContainers: args.droppableContainers.filter((container) =>
            columnIds.includes(container.id as string),
          ),
        };
        return closestCenter(filtered);
      }
      // why: pointerWithin's over-target follows the cursor, so a layout shift can't flip it
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
      const type = active.data.current?.type as "column" | "card";
      const cols = columnsRef.current;
      setActiveId(active.id as string);
      setActiveType(type);
      activeTypeRef.current = type;
      dragOriginColumnRef.current =
        type === "card"
          ? (columnOfCard(cols, String(active.id))?.id ?? null)
          : null;
      setLocalColumns([...cols.map((c) => ({ ...c, cards: [...c.cards] }))]);
    },
    [setLocalColumns],
  );

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const { active, over } = event;
      if (!over || activeTypeRef.current !== "card") return;

      if (dragOverFrameRef.current !== null) return;

      const cols = localColumnsRef.current;
      if (!cols) return;

      const activeColumn = columnOfCard(cols, String(active.id));
      const overId = String(over.id);
      const overColumn = resolveOverColumn(cols, overId);

      if (!activeColumn || !overColumn) return;

      const scheduleNextFrame = () => {
        dragOverFrameRef.current = requestAnimationFrame(() => {
          dragOverFrameRef.current = null;
        });
      };

      if (activeColumn.id === overColumn.id) {
        const activeIndex = activeColumn.cards.findIndex(
          (c) => c.id === active.id,
        );
        const overIndex = overColumn.cards.findIndex((c) => c.id === over.id);
        // why: -1 is the column drop zone, so the card goes to the end
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

      // why: drag-over and drag-end batch in one frame, so the closure's copy may be stale
      const cols = localColumnsRef.current;

      if (!over || !cols) {
        setLocalColumns(null);
        return;
      }

      if (active.data.current?.type === "column") {
        const current = columnsRef.current;
        const oldIndex = current.findIndex((c) => c.id === active.id);
        // why: over.id is a column or one of its cards; a card maps to its column
        let newIndex = current.findIndex((c) => c.id === over.id);
        if (newIndex === -1) {
          const overColumn = columnOfCard(current, String(over.id));
          if (overColumn) newIndex = current.indexOf(overColumn);
        }
        if (oldIndex !== newIndex && newIndex !== -1) {
          const result = await reorderColumns(
            boardUrl,
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

      setLocalColumns(
        (prev) => prev && applyCardMove(prev, { cardId, ...placement }),
      );

      const result = await moveCard(
        boardUrl,
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
    [boardUrl, sync, setLocalColumns],
  );

  const moveColumn = useCallback(
    async (columnId: string, direction: "left" | "right") => {
      const current = columnsRef.current;
      const index = current.findIndex((c) => c.id === columnId);
      if (index < 0) return;
      const newIndex = direction === "left" ? index - 1 : index + 1;
      if (newIndex < 0 || newIndex >= current.length) return;
      const result = await reorderColumns(
        boardUrl,
        current,
        index,
        newIndex,
        sync,
      );
      if (result.outcome === "failed") toast.error(result.message);
    },
    [boardUrl, sync],
  );

  const activeCard: Serialized<KanbanCard> | null =
    activeType === "card" && activeId
      ? (columns.flatMap((c) => c.cards).find((c) => c.id === activeId) ?? null)
      : null;

  const activeColumn: ColumnWithCards | null =
    activeType === "column" && activeId
      ? (columns.find((c) => c.id === activeId) ?? null)
      : null;

  return {
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
    onDragStart: handleDragStart,
    onDragOver: handleDragOver,
    onDragEnd: handleDragEnd,
    moveColumn,
  };
}
