import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
  within,
} from "@testing-library/react";
import type {
  KanbanBoardState,
  KanbanCard,
  KanbanColumn,
} from "@platypus/schemas";

// --- Module mocks ------------------------------------------------------------

const { replace } = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => {
  // Next hands back stable instances between renders; the board's memoized
  // children rely on that, so the mock must too.
  const searchParams = new URLSearchParams();
  const router = { replace, push: vi.fn() };
  return {
    useSearchParams: () => searchParams,
    useRouter: () => router,
    usePathname: () => "/org1/workspace/ws1/boards/board-1",
  };
});

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://test",
  useAuth: () => ({ user: { id: "u1", name: "Tester" } }),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}));

let boardState: KanbanBoardState;
const mutateBoard = vi.fn();

vi.mock("swr", () => ({
  __esModule: true,
  default: (key: unknown) => {
    if (!key) return { data: undefined, error: undefined, mutate: vi.fn() };
    if (typeof key === "string" && key.endsWith("/state")) {
      return { data: boardState, error: undefined, mutate: mutateBoard };
    }
    return { data: { results: [] }, error: undefined, mutate: vi.fn() };
  },
}));

// dnd-kit's pointer sensors don't survive jsdom, so a real drag can't be
// simulated. This renders the genuine DndContext (so the sortable children
// still get their provider) while keeping a handle on the drag callbacks the
// board passes it, which is what lets a test drive a card drop.
const dragHandlers: {
  onDragStart?: (event: unknown) => void;
  onDragOver?: (event: unknown) => void;
  onDragEnd?: (event: unknown) => void;
} = {};

vi.mock("@dnd-kit/core", async () => {
  const actual =
    await vi.importActual<typeof import("@dnd-kit/core")>("@dnd-kit/core");
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    DndContext: (props: Record<string, unknown>) => {
      dragHandlers.onDragStart = props.onDragStart as (e: unknown) => void;
      dragHandlers.onDragOver = props.onDragOver as (e: unknown) => void;
      dragHandlers.onDragEnd = props.onDragEnd as (e: unknown) => void;
      return React.createElement(actual.DndContext, props);
    },
  };
});

// Counts every `useSortable` call. The card and column components both own a
// `useSortable` hook, so a call is a render of that memoized component — the
// only way to see whether the drag handlers are re-rendering more than they
// should.
const { sortableRenders } = vi.hoisted(() => ({
  sortableRenders: new Map<string, number>(),
}));

vi.mock("@dnd-kit/sortable", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/sortable")>();
  return {
    ...actual,
    useSortable: (args: Parameters<typeof actual.useSortable>[0]) => {
      const id = String(args.id);
      sortableRenders.set(id, (sortableRenders.get(id) ?? 0) + 1);
      return actual.useSortable(args);
    },
  };
});

import { KanbanBoard } from "./kanban-board";
import {
  selectOption,
  stubAcceptedSave,
  stubRejectedSave,
  stubSaveSequence,
} from "@/lib/test-utils";

// --- Fixtures ----------------------------------------------------------------

function makeCard(overrides: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id: "card-1",
    columnId: "col-1",
    title: "A card",
    body: null,
    labelIds: [],
    assignees: [],
    dueDate: null,
    priority: "none",
    position: 1,
    createdByUserId: null,
    createdByAgentId: null,
    lastEditedByUserId: null,
    lastEditedByAgentId: null,
    createdByName: null,
    lastEditedByName: null,
    resolvedAssignees: [],
    commentCount: 0,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

function makeColumn(
  overrides: Partial<KanbanColumn> = {},
  cards: KanbanCard[] = [],
): KanbanColumn & { cards: KanbanCard[] } {
  return {
    id: "col-1",
    boardId: "board-1",
    name: "To Do",
    position: 1,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    cards,
    ...overrides,
  };
}

function makeBoardState(
  columns: (KanbanColumn & { cards: KanbanCard[] })[],
): KanbanBoardState {
  return {
    board: {
      id: "board-1",
      workspaceId: "ws1",
      name: "Test Board",
      description: null,
      labels: [],
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },
    columns,
  };
}

function renderBoard() {
  return render(
    <KanbanBoard boardId="board-1" orgId="org1" workspaceId="ws1" />,
  );
}

// --- Tests -------------------------------------------------------------------

describe("KanbanBoard transport", () => {
  beforeEach(() => {
    replace.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
    mutateBoard.mockReset();
    // jsdom has no matchMedia; the desktop/mobile checks subscribe to it.
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }) as unknown as typeof window.matchMedia;
    // Radix DropdownMenu positioning calls this during focus management.
    Element.prototype.scrollIntoView = vi.fn();
    Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
    Element.prototype.releasePointerCapture = vi.fn();
    Element.prototype.setPointerCapture = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Every dialog on the board is the same pair of claims — an accepted write
   * goes to the right endpoint and closes the dialog, a refused one names the
   * backend's reason and leaves the dialog open to retry. The gesture, the
   * endpoint, and each outcome's own fixture are the parameters.
   *
   * `perform` takes the text to submit so the refused run can describe the
   * conflict it is provoking: "a column with this name already exists" is only
   * a real scenario when the name typed is one the board already has.
   */
  const DIALOG_FLOWS: {
    name: string;
    /** The dialog's heading: gone once accepted, still there once refused. */
    heading: string;
    /** Opens the dialog, fills it with `value`, and submits. */
    perform: (value: string) => Promise<void> | void;
    url: string;
    /** What each outcome's run types. Ignored by a dialog with no input. */
    input: { accepted: string; refused: string };
    /** The accepted request, asserted on the accepted run only. */
    request: Record<string, unknown>;
    accepted: { status: number; body: unknown };
    refused: { status: number; error: string };
  }[] = [
    {
      name: "column create",
      heading: "Add Column",
      perform: (value) => {
        fireEvent.click(screen.getByRole("button", { name: /add column/i }));
        fireEvent.change(screen.getByPlaceholderText("Enter column name"), {
          target: { value },
        });
        fireEvent.click(screen.getByRole("button", { name: "Add column" }));
      },
      url: "http://test/organizations/org1/workspaces/ws1/boards/board-1/columns",
      // "To Do" is the column the board already has, so the refused run is
      // asking for a genuine duplicate.
      input: { accepted: "In Review", refused: "To Do" },
      request: {
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ name: "In Review" }),
      },
      accepted: { status: 201, body: { id: "col-2", name: "In Review" } },
      refused: {
        status: 409,
        error: "A column with this name already exists on the board",
      },
    },
    {
      name: "card create",
      heading: "Add Card",
      perform: (value) => {
        fireEvent.click(screen.getByRole("button", { name: /add card/i }));
        fireEvent.change(screen.getByPlaceholderText("Enter card title"), {
          target: { value },
        });
        fireEvent.click(screen.getByRole("button", { name: "Add card" }));
      },
      url: "http://test/organizations/org1/workspaces/ws1/boards/board-1/columns/col-1/cards",
      input: { accepted: "New task", refused: "New task" },
      request: {
        method: "POST",
        body: JSON.stringify({ title: "New task" }),
      },
      accepted: { status: 201, body: { id: "card-2" } },
      // The column went away between opening the dialog and submitting it.
      refused: { status: 404, error: "Column not found" },
    },
    {
      name: "column edit",
      heading: "Edit Column",
      perform: async (value) => {
        await openColumnMenuItem("To Do", "Edit");
        fireEvent.change(
          await screen.findByPlaceholderText("Enter column name"),
          { target: { value } },
        );
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
      },
      url: "http://test/organizations/org1/workspaces/ws1/boards/board-1/columns/col-1",
      input: { accepted: "Doing", refused: "Duplicate" },
      request: { method: "PUT", body: JSON.stringify({ name: "Doing" }) },
      accepted: { status: 200, body: { id: "col-1", name: "Doing" } },
      refused: {
        status: 409,
        error: "A column with this name already exists on the board",
      },
    },
    {
      name: "column delete",
      heading: "Delete Column",
      perform: async () => {
        await openColumnMenuItem("To Do", "Delete");
        fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
      },
      url: "http://test/organizations/org1/workspaces/ws1/boards/board-1/columns/col-1",
      input: { accepted: "", refused: "" },
      request: { method: "DELETE" },
      accepted: { status: 200, body: { message: "Column deleted" } },
      refused: { status: 404, error: "Column not found" },
    },
  ];

  describe.each(DIALOG_FLOWS)(
    "$name",
    ({ heading, perform, url, input, request, accepted, refused }) => {
      beforeEach(() => {
        boardState = makeBoardState([makeColumn()]);
      });

      it("sends the write and closes the dialog on success", async () => {
        const fetchMock = stubAcceptedSave(accepted.body, accepted.status);

        renderBoard();
        await perform(input.accepted);

        await waitFor(() =>
          expect(fetchMock).toHaveBeenCalledWith(
            url,
            expect.objectContaining(request),
          ),
        );
        await waitFor(() =>
          expect(
            screen.queryByRole("heading", { name: heading }),
          ).not.toBeInTheDocument(),
        );
        expect(toastError).not.toHaveBeenCalled();
      });

      it("shows the backend's reason and keeps the dialog open on failure", async () => {
        stubRejectedSave(refused.error, refused.status);

        renderBoard();
        await perform(input.refused);

        await waitFor(() =>
          expect(toastError).toHaveBeenCalledWith(refused.error),
        );
        expect(
          screen.getByRole("heading", { name: heading }),
        ).toBeInTheDocument();
      });
    },
  );

  describe("column move", () => {
    beforeEach(() => {
      boardState = makeBoardState([
        makeColumn({ id: "col-1", name: "To Do", position: 1 }),
        makeColumn({ id: "col-2", name: "Done", position: 2 }),
      ]);
    });

    function columnOrder() {
      return screen.getAllByText(/^(To Do|Done)$/).map((el) => el.textContent);
    }

    async function moveFirstColumnRight() {
      const columnContainer = screen.getByText("To Do").closest(".w-80")!;
      const trigger = columnContainer.querySelector(
        'button[aria-haspopup="menu"]',
      )!;
      // Radix's DropdownMenuTrigger opens on pointerdown, not plain click.
      fireEvent.pointerDown(trigger, { pointerId: 1, button: 0 });
      fireEvent.pointerUp(trigger, { pointerId: 1, button: 0 });
      fireEvent.click(trigger);
      const moveRight = await screen.findByText("Move column right");
      fireEvent.click(moveRight);
    }

    it("reorders on success without a rollback or error toast", async () => {
      const fetchMock = stubAcceptedSave({ message: "Columns reordered" });

      renderBoard();
      await moveFirstColumnRight();

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          "http://test/organizations/org1/workspaces/ws1/boards/board-1/columns/reorder",
          expect.objectContaining({
            method: "PUT",
            body: JSON.stringify({ columnIds: ["col-2", "col-1"] }),
          }),
        ),
      );
      await waitFor(() => expect(columnOrder()).toEqual(["Done", "To Do"]));
      expect(toastError).not.toHaveBeenCalled();
    });

    it("reorders on a column drag", async () => {
      const fetchMock = stubAcceptedSave({ message: "Columns reordered" });

      renderBoard();
      const active = {
        id: "col-1",
        data: { current: { type: "column" } },
        rect: { current: { translated: null, initial: null } },
      };
      act(() => {
        dragHandlers.onDragStart?.({ active });
      });
      act(() => {
        dragHandlers.onDragEnd?.({
          active,
          over: { id: "col-2", rect: { top: 0, height: 10 } },
        });
      });

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          "http://test/organizations/org1/workspaces/ws1/boards/board-1/columns/reorder",
          expect.objectContaining({
            method: "PUT",
            body: JSON.stringify({ columnIds: ["col-2", "col-1"] }),
          }),
        ),
      );
      await waitFor(() => expect(columnOrder()).toEqual(["Done", "To Do"]));
    });

    it("rolls the board back and reports the error on failure", async () => {
      stubRejectedSave("Only the workspace owner can perform this action", 403);

      renderBoard();
      await moveFirstColumnRight();

      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith(
          "Only the workspace owner can perform this action",
        ),
      );
      await waitFor(() => expect(columnOrder()).toEqual(["To Do", "Done"]));
    });
  });

  function openColumnMenuItem(columnName: string, itemText: string) {
    const columnContainer = screen.getByText(columnName).closest(".w-80")!;
    const trigger = columnContainer.querySelector(
      'button[aria-haspopup="menu"]',
    )!;
    fireEvent.pointerDown(trigger, { pointerId: 1, button: 0 });
    fireEvent.pointerUp(trigger, { pointerId: 1, button: 0 });
    fireEvent.click(trigger);
    return screen.findByText(itemText).then((item) => fireEvent.click(item));
  }

  describe("card drag", () => {
    beforeEach(() => {
      boardState = makeBoardState([
        makeColumn({ id: "col-1", name: "In Progress" }, [
          makeCard({ id: "card-1", columnId: "col-1" }),
        ]),
        makeColumn({ id: "col-2", name: "Done" }, []),
      ]);
    });

    /** Drops card-1 onto col-2, going through the board's real drag handlers. */
    function dropCardOnDoneColumn() {
      const active = {
        id: "card-1",
        data: { current: { type: "card" } },
        rect: { current: { translated: null, initial: null } },
      };
      dragHandlers.onDragStart?.({ active });
      dragHandlers.onDragEnd?.({
        active,
        over: { id: "col-2", rect: { top: 0, height: 10 } },
      });
    }

    /**
     * The full dnd-kit sequence: drag-over moves the card into the target
     * column locally before drag-end fires.  The board must still report the
     * column the drag *started* in, or the server refuses every cross-column
     * move as a conflict.
     */
    it("sends the origin column after drag-over moved the card locally", async () => {
      const fetchMock = stubAcceptedSave({ id: "card-1" });

      renderBoard();
      const active = {
        id: "card-1",
        data: { current: { type: "card" } },
        rect: { current: { translated: null, initial: null } },
      };
      const over = { id: "col-2", rect: { top: 0, height: 10 } };
      act(() => {
        dragHandlers.onDragStart?.({ active });
        dragHandlers.onDragOver?.({ active, over });
      });
      act(() => {
        dragHandlers.onDragEnd?.({ active, over });
      });

      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(init.body as string)).toMatchObject({
        columnId: "col-2",
        expectedColumnId: "col-1",
      });
    });

    it("sends the column the card was dragged from", async () => {
      const fetchMock = stubAcceptedSave({ id: "card-1" });

      renderBoard();
      dropCardOnDoneColumn();

      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/cards/card-1/move");
      expect(JSON.parse(init.body as string)).toMatchObject({
        columnId: "col-2",
        expectedColumnId: "col-1",
      });
    });

    // The card is elsewhere, so reverting to the last poll would leave it in the
    // wrong column until the next interval — hence the refetch.
    it("explains a refused drag and re-syncs the board", async () => {
      stubRejectedSave("Card is no longer in the expected column", 409);

      renderBoard();
      dropCardOnDoneColumn();

      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith(
          "This card was moved by someone else. Your change was not applied.",
        ),
      );
      expect(mutateBoard).toHaveBeenCalled();
    });
  });

  describe("drag-over render isolation", () => {
    beforeEach(() => {
      sortableRenders.clear();
      boardState = makeBoardState([
        makeColumn({ id: "col-1", name: "In Progress" }, [
          makeCard({ id: "card-1", columnId: "col-1", title: "Card one" }),
          makeCard({ id: "card-2", columnId: "col-1", title: "Card two" }),
        ]),
        makeColumn({ id: "col-2", name: "Done" }, [
          makeCard({ id: "card-3", columnId: "col-2" }),
        ]),
        makeColumn({ id: "col-3", name: "Later" }, [
          makeCard({ id: "card-4", columnId: "col-3" }),
        ]),
      ]);
    });

    function cardOrder() {
      const column = screen
        .getByText("In Progress")
        .closest(".w-80") as HTMLElement;
      return within(column)
        .getAllByText(/^Card (one|two)$/)
        .map((el) => el.textContent);
    }

    // Runs one drag-over and waits for the board's animation-frame throttle to
    // release, so the next drag-over lands in a new frame.
    async function dragOverFrame(active: unknown, over: unknown) {
      await act(async () => {
        dragHandlers.onDragOver?.({ active, over });
        await new Promise((resolve) =>
          requestAnimationFrame(() => resolve(null)),
        );
      });
    }

    it("re-renders only the column a drag-over reordered cards in", async () => {
      renderBoard();
      sortableRenders.clear();

      const active = {
        id: "card-1",
        data: { current: { type: "card" } },
        rect: { current: { translated: null, initial: null } },
      };
      act(() => {
        dragHandlers.onDragStart?.({ active });
      });
      // Drag start clones every column, so the whole board re-renders once.
      // The per-frame drag-over updates are what must stay local.
      sortableRenders.clear();

      const over = { id: "card-2", rect: { top: 0, height: 10 } };
      await dragOverFrame(active, over);
      expect(cardOrder()).toEqual(["Card two", "Card one"]);
      await dragOverFrame(active, over);
      expect(cardOrder()).toEqual(["Card one", "Card two"]);

      expect(sortableRenders.get("col-1")).toBeGreaterThan(0);
      expect(sortableRenders.get("col-2")).toBeUndefined();
      expect(sortableRenders.get("col-3")).toBeUndefined();
      expect(sortableRenders.get("card-3")).toBeUndefined();
    });
  });

  describe("card save and delete", () => {
    beforeEach(() => {
      boardState = makeBoardState([makeColumn({ id: "col-1" }, [makeCard()])]);
    });

    async function openCardDeleteConfirm() {
      fireEvent.click(screen.getByText("A card"));
      const trigger = await screen.findByRole("button", { name: "Delete" });
      // Radix's Popover trigger opens on pointerdown, not plain click.
      fireEvent.pointerDown(trigger, { pointerId: 1, button: 0 });
      fireEvent.pointerUp(trigger, { pointerId: 1, button: 0 });
      fireEvent.click(trigger);
      const confirms = await screen.findAllByRole("button", {
        name: "Delete",
      });
      fireEvent.click(confirms[confirms.length - 1]);
    }

    /**
     * The card dialog's two writes, against the same endpoint. Each names the
     * method it sends and its own proof the dialog went away, since the save
     * and the delete close different things.
     */
    const CARD_WRITES: {
      name: string;
      method: string;
      perform: () => Promise<void>;
      /** Gone once the write is accepted. */
      closed: () => HTMLElement | null;
    }[] = [
      {
        name: "save",
        method: "PUT",
        perform: async () => {
          fireEvent.click(screen.getByText("A card"));
          fireEvent.click(await screen.findByRole("button", { name: "Save" }));
        },
        closed: () => screen.queryByRole("button", { name: "Save" }),
      },
      {
        name: "delete",
        method: "DELETE",
        perform: openCardDeleteConfirm,
        closed: () => screen.queryByText("Delete this card?"),
      },
    ];

    it.each(CARD_WRITES)(
      "sends the card $name and closes the dialog on success",
      async ({ method, perform, closed }) => {
        const fetchMock = stubAcceptedSave({ id: "card-1" });

        renderBoard();
        await perform();

        await waitFor(() =>
          expect(fetchMock).toHaveBeenCalledWith(
            "http://test/organizations/org1/workspaces/ws1/boards/board-1/cards/card-1",
            expect.objectContaining({ method }),
          ),
        );
        await waitFor(() => expect(closed()).not.toBeInTheDocument());
      },
    );

    it.each(CARD_WRITES)(
      "shows the error and keeps the dialog open when the $name fails",
      async ({ perform }) => {
        stubRejectedSave("Card not found", 404);

        renderBoard();
        await perform();

        await waitFor(() =>
          expect(toastError).toHaveBeenCalledWith("Card not found"),
        );
        expect(
          screen.getByRole("button", { name: "Save" }),
        ).toBeInTheDocument();
      },
    );

    describe("with a Column change", () => {
      beforeEach(() => {
        boardState = makeBoardState([
          makeColumn({ id: "col-1", name: "To Do" }, [makeCard()]),
          makeColumn({ id: "col-2", name: "Done" }),
        ]);
      });

      async function saveInDoneColumn() {
        fireEvent.click(screen.getByText("A card"));
        await screen.findByRole("button", { name: "Save" });
        await selectOption("To Do", "Done");
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
      }

      it("updates the card, then moves it guarded by its current column", async () => {
        const fetchMock = stubAcceptedSave({ id: "card-1" });

        renderBoard();
        await saveInDoneColumn();

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        const [[updateUrl, update], [moveUrl, move]] = fetchMock.mock.calls as [
          string,
          RequestInit,
        ][];
        expect(updateUrl).toBe(
          "http://test/organizations/org1/workspaces/ws1/boards/board-1/cards/card-1",
        );
        expect(update.method).toBe("PUT");
        expect(moveUrl).toBe(
          "http://test/organizations/org1/workspaces/ws1/boards/board-1/cards/card-1/move",
        );
        expect(JSON.parse(move.body as string)).toEqual({
          columnId: "col-2",
          afterCardId: null,
          expectedColumnId: "col-1",
        });
        await waitFor(() =>
          expect(
            screen.queryByRole("button", { name: "Save" }),
          ).not.toBeInTheDocument(),
        );
      });

      it("says the changes saved but the card was not moved on a conflict, and closes", async () => {
        stubSaveSequence(
          { status: 200, body: { id: "card-1" } },
          {
            status: 409,
            body: { error: "Card is no longer in the expected column" },
          },
        );

        renderBoard();
        await saveInDoneColumn();

        await waitFor(() =>
          expect(toastError).toHaveBeenCalledWith(
            "Your changes were saved, but the card was not moved. This card was moved by someone else.",
          ),
        );
        expect(mutateBoard).toHaveBeenCalled();
        await waitFor(() =>
          expect(
            screen.queryByRole("button", { name: "Save" }),
          ).not.toBeInTheDocument(),
        );
      });

      it("says the changes saved but the card was not moved on a failure, and stays open", async () => {
        stubSaveSequence(
          { status: 200, body: { id: "card-1" } },
          { status: 404, body: { error: "Column not found" } },
        );

        renderBoard();
        await saveInDoneColumn();

        await waitFor(() =>
          expect(toastError).toHaveBeenCalledWith(
            expect.stringContaining("Column not found"),
          ),
        );
        expect(toastError.mock.calls[0][0]).toContain("saved");
        expect(mutateBoard).toHaveBeenCalled();
        expect(
          screen.getByRole("button", { name: "Save" }),
        ).toBeInTheDocument();
      });
    });
  });
});
