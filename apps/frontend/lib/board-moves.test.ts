import { describe, it, expect, vi, afterEach } from "vitest";
import type { KanbanCard } from "@platypus/schemas";
import {
  applyCardMove,
  moveCard,
  placeCard,
  reorderColumns,
  type ColumnWithCards,
} from "./board-moves";
import {
  stubAcceptedSave,
  stubRejectedSave,
  stubSaveSequence,
} from "./test-utils";

const card = (id: string) => ({ id }) as KanbanCard;

const column = (id: string, cardIds: string[]) =>
  ({ id, cards: cardIds.map(card) }) as ColumnWithCards;

const ids = (columns: ColumnWithCards[]) =>
  Object.fromEntries(columns.map((c) => [c.id, c.cards.map((x) => x.id)]));

/** A rect whose centre-Y is `centreY`. */
const rect = (centreY: number) => ({ top: centreY - 5, height: 10 });

describe("placeCard", () => {
  const columns = [column("col-1", ["a", "b", "c"]), column("col-2", ["d"])];

  it("drops after the last card on a non-empty column's drop zone", () => {
    expect(
      placeCard(columns, {
        activeId: "a",
        overId: "column-drop-col-2",
        activeRect: rect(0),
        overRect: rect(0),
      }),
    ).toEqual({ fromColumnId: "col-1", toColumnId: "col-2", afterCardId: "d" });
  });

  it("drops at the head of an empty column", () => {
    expect(
      placeCard([...columns, column("col-3", [])], {
        activeId: "a",
        overId: "col-3",
        activeRect: rect(0),
        overRect: rect(0),
      }),
    ).toEqual({
      fromColumnId: "col-1",
      toColumnId: "col-3",
      afterCardId: null,
    });
  });

  it("goes after the over card when the active centre is below it", () => {
    expect(
      placeCard(columns, {
        activeId: "a",
        overId: "b",
        activeRect: rect(20),
        overRect: rect(10),
      }),
    ).toMatchObject({ toColumnId: "col-1", afterCardId: "b" });
  });

  it("goes before the over card when the active centre is above it", () => {
    expect(
      placeCard(columns, {
        activeId: "a",
        overId: "c",
        activeRect: rect(0),
        overRect: rect(10),
      }),
    ).toMatchObject({ toColumnId: "col-1", afterCardId: "b" });
    expect(
      placeCard(columns, {
        activeId: "d",
        overId: "a",
        activeRect: rect(0),
        overRect: rect(10),
      }),
    ).toMatchObject({ toColumnId: "col-1", afterCardId: null });
  });

  it("falls back to array order when over itself in the same column", () => {
    const place = (activeId: string) =>
      placeCard(columns, {
        activeId,
        overId: activeId,
        activeRect: null,
        overRect: rect(0),
      });
    expect(place("b")).toMatchObject({ toColumnId: "col-1", afterCardId: "a" });
    expect(place("a")).toMatchObject({
      toColumnId: "col-1",
      afterCardId: null,
    });
  });

  it("goes after the target's last card when over itself after crossing", () => {
    // Drag-over has already moved "a" to the end of col-2 locally, so the
    // over target is "a" itself, and the origin is col-1.
    expect(
      placeCard([column("col-1", ["b"]), column("col-2", ["d", "a"])], {
        activeId: "a",
        overId: "a",
        activeRect: null,
        overRect: rect(0),
      }),
    ).toMatchObject({ toColumnId: "col-2", afterCardId: "d" });
  });

  it("goes after the target's last card when over another column's id", () => {
    expect(
      placeCard(columns, {
        activeId: "a",
        overId: "col-2",
        activeRect: null,
        overRect: rect(0),
      }),
    ).toEqual({ fromColumnId: "col-1", toColumnId: "col-2", afterCardId: "d" });
  });

  it("returns null when the active card is on no column", () => {
    expect(
      placeCard(columns, {
        activeId: "zzz",
        overId: "col-2",
        activeRect: null,
        overRect: rect(0),
      }),
    ).toBeNull();
  });
});

describe("applyCardMove", () => {
  const columns = [column("col-1", ["a", "b"]), column("col-2", ["c", "d"])];

  it("moves a card across columns to the head for null", () => {
    expect(
      ids(
        applyCardMove(columns, {
          cardId: "a",
          fromColumnId: "col-1",
          toColumnId: "col-2",
          afterCardId: null,
        }),
      ),
    ).toEqual({ "col-1": ["b"], "col-2": ["a", "c", "d"] });
  });

  it("moves a card across columns after afterCardId", () => {
    expect(
      ids(
        applyCardMove(columns, {
          cardId: "a",
          fromColumnId: "col-1",
          toColumnId: "col-2",
          afterCardId: "c",
        }),
      ),
    ).toEqual({ "col-1": ["b"], "col-2": ["c", "a", "d"] });
  });

  it("reorders within one column, moving only that card", () => {
    expect(
      ids(
        applyCardMove(columns, {
          cardId: "a",
          fromColumnId: "col-1",
          toColumnId: "col-1",
          afterCardId: "b",
        }),
      ),
    ).toEqual({ "col-1": ["b", "a"], "col-2": ["c", "d"] });
  });

  it("does not mutate its input", () => {
    const before = JSON.stringify(columns);
    applyCardMove(columns, {
      cardId: "a",
      fromColumnId: "col-1",
      toColumnId: "col-2",
      afterCardId: null,
    });
    expect(JSON.stringify(columns)).toBe(before);
  });
});

describe("writes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const baseUrl = "http://test/boards/board-1";
  const sync = () => ({ setColumns: vi.fn(), refetch: vi.fn() });
  const move = {
    cardId: "card-1",
    columnId: "col-2",
    afterCardId: null,
    expectedColumnId: "col-1",
  };

  describe("moveCard", () => {
    it("always sends expectedColumnId and refetches on success", async () => {
      const fetchMock = stubAcceptedSave({ id: "card-1" });
      const s = sync();

      expect(await moveCard(baseUrl, move, s)).toEqual({ outcome: "moved" });

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${baseUrl}/cards/card-1/move`);
      expect(JSON.parse(init.body as string)).toEqual({
        columnId: "col-2",
        afterCardId: null,
        expectedColumnId: "col-1",
      });
      expect(s.refetch).toHaveBeenCalled();
      expect(s.setColumns).not.toHaveBeenCalled();
    });

    it("maps a 409 to conflict, drops the optimistic copy and refetches", async () => {
      stubRejectedSave("Card is no longer in the expected column", 409);
      const s = sync();

      expect(await moveCard(baseUrl, move, s)).toEqual({
        outcome: "conflict",
        message: "This card was moved by someone else.",
      });
      expect(s.setColumns).toHaveBeenCalledWith(null);
      expect(s.refetch).toHaveBeenCalled();
    });

    it.each([404, 500])(
      "maps a %i to failed with the backend's message",
      async (status) => {
        stubRejectedSave("Column not found", status);
        const s = sync();

        expect(await moveCard(baseUrl, move, s)).toEqual({
          outcome: "failed",
          message: "Column not found",
        });
        expect(s.setColumns).toHaveBeenCalledWith(null);
        expect(s.refetch).toHaveBeenCalled();
      },
    );
  });

  describe("reorderColumns", () => {
    const columns = [column("col-1", []), column("col-2", [])];

    it("applies the new order, sends it and refetches", async () => {
      const fetchMock = stubAcceptedSave({ message: "Columns reordered" });
      const s = sync();

      expect(await reorderColumns(baseUrl, columns, 0, 1, s)).toEqual({
        outcome: "reordered",
      });
      expect(ids(s.setColumns.mock.calls[0][0])).toEqual({
        "col-2": [],
        "col-1": [],
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${baseUrl}/columns/reorder`);
      expect(init.method).toBe("PUT");
      expect(JSON.parse(init.body as string)).toEqual({
        columnIds: ["col-2", "col-1"],
      });
      expect(s.refetch).toHaveBeenCalled();
    });

    it("rolls back on failure", async () => {
      stubSaveSequence({ status: 403, body: { error: "Nope" } });
      const s = sync();

      expect(await reorderColumns(baseUrl, columns, 0, 1, s)).toEqual({
        outcome: "failed",
        message: "Nope",
      });
      expect(s.setColumns).toHaveBeenLastCalledWith(null);
      expect(s.refetch).not.toHaveBeenCalled();
    });
  });
});
