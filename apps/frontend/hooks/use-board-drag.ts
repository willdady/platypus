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
  moveCard,
  parseDropZoneId,
  placeCard,
  reorderColumns,
  type BoardSync,
  type ColumnWithCards,
} from "@/lib/board-moves";

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

/**
 * The Board's drag state and gestures: the optimistic column copy a drag
 * mutates, the dnd-kit sensors and collision rule, and the handlers that turn
 * a drop into a write. Kept out of the view so the render reads a small
 * surface, and the frame-coalescing and stale-closure guards below sit beside
 * the state they protect.
 *
 * `columns` is the local copy while a drag or write is in flight, otherwise
 * the server's. `sync` is what `lib/board-moves` writes through, so a card
 * moved from the Card dialog lands by the same path as a drag.
 */
export function useBoardDrag({
  serverColumns,
  boardUrl,
  refetch,
}: {
  /** The server's columns for the board, from the polled board state. */
  serverColumns: ColumnWithCards[];
  /** The board's own URL, which every move writes under. */
  boardUrl: string;
  /** Re-reads the board, so a refused move can fall back to the server's copy. */
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
  // Throttle drag-over updates to once per animation frame. dnd-kit fires
  // onDragOver from a useEffect on overId, so a setLocalColumns inside that
  // handler can shift layout, change overId, re-fire the effect, and loop
  // (React #185). Coalescing to one update per frame breaks the loop while
  // still letting the user see cards animate as they drag.
  const dragOverFrameRef = useRef<number | null>(null);
  // The column a card drag started from, captured before drag-over rewrites
  // localColumns. Cross-column moves are applied to the local copy while the
  // card is still in flight, so by drag-end the card already sits in its
  // target column locally — reading the source from there would send the
  // target as `expectedColumnId` and refuse every cross-column move.
  const dragOriginColumnRef = useRef<string | null>(null);

  const columns: ColumnWithCards[] = useMemo(
    () => localColumns ?? serverColumns,
    [localColumns, serverColumns],
  );

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
  const [prevData, setPrevData] = useState(serverColumns);
  if (serverColumns !== prevData && !activeId) {
    setPrevData(serverColumns);
    // Use the raw state setter here: setLocalColumns writes localColumnsRef,
    // and refs must not be written during render. The ref is re-synced on the
    // next drag start (and only ever read inside drag handlers), so leaving it
    // until then is safe.
    if (localColumns) _setLocalColumns(null);
  }

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
      // Every draggable (a column, a card) names its kind in its data.
      const type = active.data.current?.type as "column" | "card";
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

  /** Moves a column one place from its menu, the keyboard equivalent of a drag. */
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
    /** The local copy while a drag or write is in flight, else the server's. */
    columns,
    /** The last committed columns, for handlers that run between commits. */
    columnsRef,
    /** What `lib/board-moves` writes through. */
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
