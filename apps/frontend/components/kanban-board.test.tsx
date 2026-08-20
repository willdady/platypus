import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type {
  KanbanBoardState,
  KanbanCard,
  KanbanColumn,
} from "@platypus/schemas";

// --- Module mocks ------------------------------------------------------------

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace, push: vi.fn() }),
  usePathname: () => "/org1/workspace/ws1/boards/board-1",
}));

vi.mock("@/app/client-context", () => ({
  useBackendUrl: () => "http://test",
}));

vi.mock("@/components/auth-provider", () => ({
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

import { KanbanBoard } from "./kanban-board";

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

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => body,
  } as unknown as Response;
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

  describe("column create", () => {
    beforeEach(() => {
      boardState = makeBoardState([makeColumn()]);
    });

    it("POSTs the new column and closes the dialog on success", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          jsonResponse(201, { id: "col-2", name: "In Review" }),
        );
      vi.stubGlobal("fetch", fetchMock);

      renderBoard();

      fireEvent.click(screen.getByRole("button", { name: /add column/i }));
      fireEvent.change(screen.getByPlaceholderText("Enter column name"), {
        target: { value: "In Review" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Add column" }));

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          "http://test/organizations/org1/workspaces/ws1/boards/board-1/columns",
          expect.objectContaining({
            method: "POST",
            credentials: "include",
            body: JSON.stringify({ name: "In Review" }),
          }),
        ),
      );

      await waitFor(() =>
        expect(screen.queryByText("Add Column")).not.toBeInTheDocument(),
      );
      expect(toastError).not.toHaveBeenCalled();
    });

    it("shows the conflict message and keeps the dialog open on failure", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse(409, {
          error: "A column with this name already exists on the board",
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      renderBoard();

      fireEvent.click(screen.getByRole("button", { name: /add column/i }));
      fireEvent.change(screen.getByPlaceholderText("Enter column name"), {
        target: { value: "To Do" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Add column" }));

      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith(
          "A column with this name already exists on the board",
        ),
      );
      expect(
        screen.getByRole("heading", { name: "Add Column" }),
      ).toBeInTheDocument();
    });
  });

  describe("card create", () => {
    beforeEach(() => {
      boardState = makeBoardState([makeColumn()]);
    });

    it("POSTs the new card and closes the dialog on success", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse(201, { id: "card-2" }));
      vi.stubGlobal("fetch", fetchMock);

      renderBoard();

      fireEvent.click(screen.getByRole("button", { name: /add card/i }));
      fireEvent.change(screen.getByPlaceholderText("Enter card title"), {
        target: { value: "New task" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Add card" }));

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          "http://test/organizations/org1/workspaces/ws1/boards/board-1/columns/col-1/cards",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({ title: "New task" }),
          }),
        ),
      );
      await waitFor(() =>
        expect(screen.queryByText("Add Card")).not.toBeInTheDocument(),
      );
    });

    it("shows the failure message and keeps the dialog open on failure", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse(404, { error: "Column not found" }));
      vi.stubGlobal("fetch", fetchMock);

      renderBoard();

      fireEvent.click(screen.getByRole("button", { name: /add card/i }));
      fireEvent.change(screen.getByPlaceholderText("Enter card title"), {
        target: { value: "New task" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Add card" }));

      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith("Column not found"),
      );
      expect(
        screen.getByRole("heading", { name: "Add Card" }),
      ).toBeInTheDocument();
    });
  });

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
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse(200, { message: "Columns reordered" }));
      vi.stubGlobal("fetch", fetchMock);

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

    it("rolls the board back and reports the error on failure", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse(403, {
          error: "Only the workspace owner can perform this action",
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

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

  describe("column edit", () => {
    beforeEach(() => {
      boardState = makeBoardState([makeColumn()]);
    });

    it("PUTs the renamed column and closes the dialog on success", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse(200, { id: "col-1", name: "Doing" }));
      vi.stubGlobal("fetch", fetchMock);

      renderBoard();
      await openColumnMenuItem("To Do", "Edit");

      const input = await screen.findByPlaceholderText("Enter column name");
      fireEvent.change(input, { target: { value: "Doing" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          "http://test/organizations/org1/workspaces/ws1/boards/board-1/columns/col-1",
          expect.objectContaining({
            method: "PUT",
            body: JSON.stringify({ name: "Doing" }),
          }),
        ),
      );
      await waitFor(() =>
        expect(screen.queryByText("Edit Column")).not.toBeInTheDocument(),
      );
    });

    it("shows the error and keeps the dialog open on failure", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse(409, {
          error: "A column with this name already exists on the board",
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      renderBoard();
      await openColumnMenuItem("To Do", "Edit");

      const input = await screen.findByPlaceholderText("Enter column name");
      fireEvent.change(input, { target: { value: "Duplicate" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith(
          "A column with this name already exists on the board",
        ),
      );
      expect(
        screen.getByRole("heading", { name: "Edit Column" }),
      ).toBeInTheDocument();
    });
  });

  describe("column delete", () => {
    beforeEach(() => {
      boardState = makeBoardState([makeColumn()]);
    });

    it("DELETEs the column and closes the dialog on success", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse(200, { message: "Column deleted" }));
      vi.stubGlobal("fetch", fetchMock);

      renderBoard();
      await openColumnMenuItem("To Do", "Delete");

      fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          "http://test/organizations/org1/workspaces/ws1/boards/board-1/columns/col-1",
          expect.objectContaining({ method: "DELETE" }),
        ),
      );
      await waitFor(() =>
        expect(screen.queryByText("Delete Column")).not.toBeInTheDocument(),
      );
    });

    it("shows the error and keeps the dialog open on failure", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse(404, { error: "Column not found" }));
      vi.stubGlobal("fetch", fetchMock);

      renderBoard();
      await openColumnMenuItem("To Do", "Delete");

      fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith("Column not found"),
      );
      expect(
        screen.getByRole("heading", { name: "Delete Column" }),
      ).toBeInTheDocument();
    });
  });

  describe("card save and delete", () => {
    beforeEach(() => {
      boardState = makeBoardState([makeColumn({ id: "col-1" }, [makeCard()])]);
    });

    it("PUTs the card's changes and closes the dialog on success", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse(200, { id: "card-1" }));
      vi.stubGlobal("fetch", fetchMock);

      renderBoard();
      fireEvent.click(screen.getByText("A card"));
      fireEvent.click(await screen.findByRole("button", { name: "Save" }));

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          "http://test/organizations/org1/workspaces/ws1/boards/board-1/cards/card-1",
          expect.objectContaining({ method: "PUT" }),
        ),
      );
      await waitFor(() =>
        expect(screen.queryByText("Delete this card?")).not.toBeInTheDocument(),
      );
    });

    it("shows the error and keeps the dialog open when the save fails", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse(404, { error: "Card not found" }));
      vi.stubGlobal("fetch", fetchMock);

      renderBoard();
      fireEvent.click(screen.getByText("A card"));
      fireEvent.click(await screen.findByRole("button", { name: "Save" }));

      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith("Card not found"),
      );
      expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
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

    it("DELETEs the card and closes the dialog on success", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse(200, { message: "Card deleted" }));
      vi.stubGlobal("fetch", fetchMock);

      renderBoard();
      await openCardDeleteConfirm();

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          "http://test/organizations/org1/workspaces/ws1/boards/board-1/cards/card-1",
          expect.objectContaining({ method: "DELETE" }),
        ),
      );
    });

    it("shows the error and keeps the dialog open when the delete fails", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse(404, { error: "Card not found" }));
      vi.stubGlobal("fetch", fetchMock);

      renderBoard();
      await openCardDeleteConfirm();

      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith("Card not found"),
      );
      expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    });
  });
});
