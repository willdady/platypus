import { arrayMove } from "@dnd-kit/sortable";
import type { KanbanCard, KanbanColumn } from "@platypus/schemas";
import { writeAt } from "./api-write";
import { joinUrl } from "./utils";

/**
 * Every way a Card or Column changes place on a Board — the drag, the column
 * menu, and the Card dialog's Column field — goes through here, so the
 * stale-board guard and its conflict handling can't be skipped by one of them.
 */

export type ColumnWithCards = KanbanColumn & { cards: KanbanCard[] };

const DROP_ZONE_PREFIX = "column-drop-";

export function parseDropZoneId(id: string): string | null {
  return id.startsWith(DROP_ZONE_PREFIX)
    ? id.slice(DROP_ZONE_PREFIX.length)
    : null;
}

type Rect = { top: number; height: number };

export interface CardDrop {
  activeId: string;
  /** A card id, a column id, or a column drop zone id. */
  overId: string;
  /** Null when dnd-kit has not measured the dragged card. */
  activeRect: Rect | null;
  overRect: Rect;
}

export interface CardPlacement {
  /** The column the card sits in within `columns`. */
  fromColumnId: string;
  toColumnId: string;
  /** The card to sit behind; null means the head of the column. */
  afterCardId: string | null;
}

/**
 * Where a dropped card lands. Null when the dragged card is on no column.
 */
export function placeCard(
  columns: ColumnWithCards[],
  { activeId, overId, activeRect, overRect }: CardDrop,
): CardPlacement | null {
  const sourceColumn = columns.find((col) =>
    col.cards.some((c) => c.id === activeId),
  );
  if (!sourceColumn) return null;

  const droppableColumnId = parseDropZoneId(overId);
  const targetColumn =
    (droppableColumnId
      ? columns.find((col) => col.id === droppableColumnId)
      : null) ??
    columns.find((col) => col.id === overId) ??
    columns.find((col) => col.cards.some((c) => c.id === overId)) ??
    sourceColumn;

  const isDropZone = droppableColumnId !== null;
  const targetCards = targetColumn.cards.filter((c) => c.id !== activeId);

  let afterCardId: string | null;
  if (isDropZone || targetCards.length === 0) {
    // Dropped on the column drop zone or onto an empty column
    afterCardId =
      targetCards.length > 0 ? targetCards[targetCards.length - 1].id : null;
  } else {
    // Dropped over a specific card – decide whether to go before or
    // after it by comparing the dragged card's current centre-Y with
    // the over card's centre-Y.
    const overIdx = targetCards.findIndex((c) => c.id === overId);
    if (overIdx === -1) {
      // over card is the active card itself – fall back to array order
      if (targetColumn.id === sourceColumn.id) {
        const cardIndex = sourceColumn.cards.findIndex(
          (c) => c.id === activeId,
        );
        afterCardId =
          cardIndex > 0 ? sourceColumn.cards[cardIndex - 1].id : null;
      } else {
        afterCardId =
          targetCards.length > 0
            ? targetCards[targetCards.length - 1].id
            : null;
      }
    } else {
      const activeCenterY = activeRect
        ? activeRect.top + activeRect.height / 2
        : 0;
      const overCenterY = overRect.top + overRect.height / 2;
      if (activeCenterY > overCenterY) {
        afterCardId = targetCards[overIdx].id;
      } else {
        afterCardId = overIdx > 0 ? targetCards[overIdx - 1].id : null;
      }
    }
  }

  return {
    fromColumnId: sourceColumn.id,
    toColumnId: targetColumn.id,
    afterCardId,
  };
}

export interface CardMove {
  cardId: string;
  fromColumnId: string;
  toColumnId: string;
  /** Null means the head of the column. */
  afterCardId: string | null;
}

/** The columns after `move`, applied locally ahead of the server. */
export function applyCardMove(
  columns: ColumnWithCards[],
  { cardId, fromColumnId, toColumnId, afterCardId }: CardMove,
): ColumnWithCards[] {
  const movedCard = columns
    .find((c) => c.id === fromColumnId)
    ?.cards.find((c) => c.id === cardId);
  if (!movedCard) return columns;
  return columns.map((c) => {
    if (c.id === fromColumnId && fromColumnId !== toColumnId) {
      return { ...c, cards: c.cards.filter((card) => card.id !== cardId) };
    }
    if (c.id === toColumnId) {
      const cards = c.cards.filter((card) => card.id !== cardId);
      if (afterCardId === null) {
        cards.unshift(movedCard);
      } else {
        const afterIdx = cards.findIndex((card) => card.id === afterCardId);
        cards.splice(afterIdx + 1, 0, movedCard);
      }
      return { ...c, cards };
    }
    return c;
  });
}

/** How a write hands its result back to the board. */
export interface BoardSync {
  /** Sets the local optimistic copy; null drops it for the last poll. */
  setColumns: (columns: ColumnWithCards[] | null) => void;
  refetch: () => Promise<unknown>;
}

/** Not a failed write but a stale board, so it says who moved the card. */
const CARD_MOVED_ELSEWHERE = "This card was moved by someone else.";

export type MoveResult =
  { outcome: "moved" } | { outcome: "conflict" | "failed"; message: string };

/**
 * Moves a card on the server. Always refetches: on a conflict, dropping the
 * optimistic copy falls back to the last poll — the very state that just lost
 * the race — so leaving it would show the card in the wrong column until the
 * next interval.
 */
export async function moveCard(
  baseUrl: string,
  move: {
    cardId: string;
    columnId: string;
    afterCardId: string | null;
    /**
     * The column the caller believes the card is in. The board polls, so
     * this may already be out of date; sending it makes the move conditional,
     * and an agent's move that landed meanwhile is reported rather than
     * overwritten.
     */
    expectedColumnId: string;
  },
  sync: BoardSync,
): Promise<MoveResult> {
  const { cardId, ...data } = move;
  const outcome = await writeAt(joinUrl(baseUrl, `cards/${cardId}/move`), {
    method: "POST",
    data,
  });
  if (outcome.outcome !== "success") sync.setColumns(null);
  await sync.refetch();
  if (outcome.outcome === "success") return { outcome: "moved" };
  if (outcome.outcome === "conflict") {
    return { outcome: "conflict", message: CARD_MOVED_ELSEWHERE };
  }
  return { outcome: "failed", message: outcome.message };
}

/**
 * Moves the column at `fromIndex` to `toIndex`, locally at once and then on
 * the server, rolling the local copy back if the server refuses.
 */
export async function reorderColumns(
  baseUrl: string,
  columns: ColumnWithCards[],
  fromIndex: number,
  toIndex: number,
  sync: BoardSync,
): Promise<{ outcome: "reordered" } | { outcome: "failed"; message: string }> {
  const reordered = arrayMove(columns, fromIndex, toIndex);
  sync.setColumns(reordered);
  const outcome = await writeAt(joinUrl(baseUrl, "columns/reorder"), {
    method: "PUT",
    data: { columnIds: reordered.map((c) => c.id) },
  });
  if (outcome.outcome !== "success") {
    sync.setColumns(null);
    return { outcome: "failed", message: outcome.message };
  }
  await sync.refetch();
  return { outcome: "reordered" };
}
