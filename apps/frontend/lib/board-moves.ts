import { arrayMove } from "@dnd-kit/sortable";
import type { KanbanCard, KanbanColumn } from "@platypus/schemas";
import { writeAt, type Serialized } from "./api-write";
import { joinUrl } from "./utils";

export type ColumnWithCards = Serialized<KanbanColumn> & {
  cards: Serialized<KanbanCard>[];
};

const DROP_ZONE_PREFIX = "column-drop-";

export function dropZoneId(columnId: string): string {
  return `${DROP_ZONE_PREFIX}${columnId}`;
}

export function parseDropZoneId(id: string): string | null {
  return id.startsWith(DROP_ZONE_PREFIX)
    ? id.slice(DROP_ZONE_PREFIX.length)
    : null;
}

export function columnOfCard(
  columns: ColumnWithCards[],
  cardId: string,
): ColumnWithCards | undefined {
  return columns.find((col) => col.cards.some((c) => c.id === cardId));
}

export function resolveOverColumn(
  columns: ColumnWithCards[],
  overId: string,
): ColumnWithCards | undefined {
  const droppableColumnId = parseDropZoneId(overId);
  return (
    (droppableColumnId
      ? columns.find((col) => col.id === droppableColumnId)
      : undefined) ??
    columns.find((col) => col.id === overId) ??
    columnOfCard(columns, overId)
  );
}

type Rect = { top: number; height: number };

export type CardDrop = {
  activeId: string;
  overId: string;
  activeRect: Rect | null;
  overRect: Rect;
};

export type CardPlacement = {
  fromColumnId: string;
  toColumnId: string;
  afterCardId: string | null;
};

export function placeCard(
  columns: ColumnWithCards[],
  { activeId, overId, activeRect, overRect }: CardDrop,
): CardPlacement | null {
  const sourceColumn = columnOfCard(columns, activeId);
  if (!sourceColumn) return null;

  const droppableColumnId = parseDropZoneId(overId);
  const targetColumn = resolveOverColumn(columns, overId) ?? sourceColumn;

  const isDropZone = droppableColumnId !== null;
  const targetCards = targetColumn.cards.filter((c) => c.id !== activeId);

  let afterCardId: string | null;
  if (isDropZone || targetCards.length === 0) {
    afterCardId =
      targetCards.length > 0 ? targetCards[targetCards.length - 1].id : null;
  } else {
    const overIdx = targetCards.findIndex((c) => c.id === overId);
    if (overIdx === -1) {
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

export type CardMove = {
  cardId: string;
  fromColumnId: string;
  toColumnId: string;
  afterCardId: string | null;
};

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

export type BoardSync = {
  setColumns: (columns: ColumnWithCards[] | null) => void;
  refetch: () => Promise<unknown>;
};

const CARD_MOVED_ELSEWHERE = "This card was moved by someone else.";

export type MoveResult =
  { outcome: "moved" } | { outcome: "conflict" | "failed"; message: string };

// why: refetch even on conflict — the dropped copy falls back to the same stale poll
export async function moveCard(
  baseUrl: string,
  move: {
    cardId: string;
    columnId: string;
    afterCardId: string | null;
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
