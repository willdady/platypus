import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockDb,
  mockSession,
  mockNoSession,
  resetMockDb,
} from "../test-utils.ts";
import app from "../server.ts";

// Mock nanoid to return predictable IDs
vi.mock("nanoid", () => ({
  nanoid: vi.fn(() => "test-id-123"),
}));

describe("Kanban Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
  });

  const orgId = "org-1";
  const workspaceId = "ws-1";
  const boardId = "board-1";
  const baseUrl = `/organizations/${orgId}/workspaces/${workspaceId}/boards`;

  describe("GET /", () => {
    it("should return 401 if not authenticated", async () => {
      mockNoSession();
      const res = await app.request(baseUrl);
      expect(res.status).toBe(401);
    });

    it("should list all boards in workspace", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      const mockBoards = [{ id: "board-1", name: "Board 1", workspaceId }];
      mockDb.orderBy.mockResolvedValueOnce(mockBoards);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: mockBoards });
    });
  });

  describe("POST /", () => {
    it("should return 401 if not authenticated", async () => {
      mockNoSession();
      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({ name: "New Board" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(401);
    });

    it("should return 403 if user is not workspace owner", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "other-user" }]); // requireWorkspaceAccess

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({ name: "New Board" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(403);
    });

    it("should create board with default columns", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      const mockBoard = { id: "test-id-123", name: "New Board", workspaceId };
      mockDb.returning.mockResolvedValueOnce([mockBoard]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({ name: "New Board" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual(mockBoard);
    });

    it("should return 400 if name is missing", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /:boardId", () => {
    it("should return 404 if board not found", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([]); // get board

      const res = await app.request(`${baseUrl}/${boardId}`);
      expect(res.status).toBe(404);
    });

    it("should return board if found", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      const mockBoard = { id: boardId, name: "Board 1", workspaceId };
      mockDb.limit.mockResolvedValueOnce([mockBoard]);

      const res = await app.request(`${baseUrl}/${boardId}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(mockBoard);
    });
  });

  describe("PUT /:boardId", () => {
    it("should update board if user is workspace owner", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      const mockBoard = { id: boardId, name: "Updated Board" };
      mockDb.returning.mockResolvedValueOnce([mockBoard]);

      const res = await app.request(`${baseUrl}/${boardId}`, {
        method: "PUT",
        body: JSON.stringify({ name: "Updated Board" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(mockBoard);
    });

    it("should return 404 if board not found", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      mockDb.returning.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/${boardId}`, {
        method: "PUT",
        body: JSON.stringify({ name: "Updated Board" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /:boardId", () => {
    it("should delete board if user is workspace owner", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      mockDb.returning.mockResolvedValueOnce([{ id: boardId }]);

      const res = await app.request(`${baseUrl}/${boardId}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Board deleted" });
    });

    it("should return 404 if board not found", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      mockDb.returning.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/${boardId}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /:boardId/state", () => {
    it("should return 404 if board not found", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([]); // get board

      const res = await app.request(`${baseUrl}/${boardId}/state`);
      expect(res.status).toBe(404);
    });

    it("should return board state with columns and cards", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      const mockBoard = {
        id: boardId,
        name: "Board 1",
        workspaceId,
        labels: [{ id: "label-1", name: "Bug", color: "#ef4444" }],
      };
      mockDb.limit.mockResolvedValueOnce([mockBoard]);

      const mockColumns = [
        { id: "col-1", boardId, name: "To Do", position: 1.0 },
      ];
      mockDb.orderBy.mockResolvedValueOnce(mockColumns); // columns query

      const mockCards = [
        {
          id: "card-1",
          columnId: "col-1",
          title: "Card 1",
          position: 1.0,
          createdByUserId: null,
          lastEditedByUserId: null,
        },
      ];
      mockDb.orderBy.mockResolvedValueOnce(mockCards); // cards query
      mockDb.groupBy.mockResolvedValueOnce([]); // comment counts query

      const res = await app.request(`${baseUrl}/${boardId}/state`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.board).toEqual(mockBoard);
      expect(Array.isArray(body.columns)).toBe(true);
      expect(body.columns).toHaveLength(1);
      expect(body.columns[0].cards).toHaveLength(1);
      expect(body.columns[0].cards[0].createdByName).toBeNull();
    });
  });

  describe("POST /:boardId/columns", () => {
    it("should return 404 if board not found", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([]); // get board

      const res = await app.request(`${baseUrl}/${boardId}/columns`, {
        method: "POST",
        body: JSON.stringify({ name: "New Column" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(404);
    });

    it("should create column", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      const mockBoard = { id: boardId, name: "Board 1", workspaceId };
      mockDb.limit.mockResolvedValueOnce([mockBoard]);

      mockDb.orderBy.mockResolvedValueOnce([{ maxPos: 1.0 }]);

      const mockColumn = { id: "test-id-123", boardId, name: "New Column", position: 2.0 };
      mockDb.returning.mockResolvedValueOnce([mockColumn]);

      const res = await app.request(`${baseUrl}/${boardId}/columns`, {
        method: "POST",
        body: JSON.stringify({ name: "New Column" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual(mockColumn);
    });
  });

  describe("PUT /:boardId/columns/:columnId", () => {
    it("should update column", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      const mockColumn = { id: "col-1", boardId, name: "Updated Column" };
      mockDb.returning.mockResolvedValueOnce([mockColumn]);

      const res = await app.request(`${baseUrl}/${boardId}/columns/col-1`, {
        method: "PUT",
        body: JSON.stringify({ name: "Updated Column" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(mockColumn);
    });

    it("should return 404 if column not found", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      mockDb.returning.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/${boardId}/columns/col-1`, {
        method: "PUT",
        body: JSON.stringify({ name: "Updated Column" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /:boardId/columns/:columnId", () => {
    it("should delete column", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      mockDb.returning.mockResolvedValueOnce([{ id: "col-1" }]);

      const res = await app.request(`${baseUrl}/${boardId}/columns/col-1`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Column deleted" });
    });

    it("should return 404 if column not found", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      mockDb.returning.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/${boardId}/columns/col-1`, {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /:boardId/columns/reorder", () => {
    it("should return 404 if board not found", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([]); // get board

      const res = await app.request(`${baseUrl}/${boardId}/columns/reorder`, {
        method: "PUT",
        body: JSON.stringify({ columnIds: ["col-1", "col-2"] }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(404);
    });

    it("should reorder columns", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      const mockBoard = { id: boardId, name: "Board 1", workspaceId };
      mockDb.limit.mockResolvedValueOnce([mockBoard]);

      // board columns validation
      mockDb.orderBy.mockResolvedValueOnce([
        { id: "col-1" },
        { id: "col-2" },
      ]);

      const res = await app.request(`${baseUrl}/${boardId}/columns/reorder`, {
        method: "PUT",
        body: JSON.stringify({ columnIds: ["col-1", "col-2"] }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Columns reordered" });
      expect(mockDb.transaction).toHaveBeenCalled();
    });

    it("should return 400 if columnIds contain IDs not belonging to board", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      const mockBoard = { id: boardId, name: "Board 1", workspaceId };
      mockDb.limit.mockResolvedValueOnce([mockBoard]); // board found

      // board columns
      mockDb.orderBy.mockResolvedValueOnce([
        { id: "col-1" },
        { id: "col-2" },
      ]);

      const res = await app.request(`${baseUrl}/${boardId}/columns/reorder`, {
        method: "PUT",
        body: JSON.stringify({ columnIds: ["col-1", "col-foreign"] }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /:boardId/columns/:columnId/cards", () => {
    it("should create card", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      mockDb.orderBy.mockResolvedValueOnce([{ maxPos: 1.0 }]);

      const mockCard = {
        id: "test-id-123",
        columnId: "col-1",
        title: "New Card",
        position: 2.0,
      };
      mockDb.returning.mockResolvedValueOnce([mockCard]);

      const res = await app.request(`${baseUrl}/${boardId}/columns/col-1/cards`, {
        method: "POST",
        body: JSON.stringify({ title: "New Card" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual(mockCard);
    });
  });

  describe("PUT /:boardId/cards/:cardId - board membership", () => {
    it("should return 404 when card does not belong to board", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess
      // card update returns empty (card not in this board)
      mockDb.returning.mockResolvedValueOnce([]);

      const res = await app.request(
        `${baseUrl}/${boardId}/cards/card-from-other-board`,
        {
          method: "PUT",
          body: JSON.stringify({ title: "Hack" }),
          headers: { "Content-Type": "application/json" },
        },
      );
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /:boardId/cards/:cardId", () => {
    it("should update card", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      const mockCard = { id: "card-1", title: "Updated Card" };
      mockDb.returning.mockResolvedValueOnce([mockCard]);

      const res = await app.request(`${baseUrl}/${boardId}/cards/card-1`, {
        method: "PUT",
        body: JSON.stringify({ title: "Updated Card" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(mockCard);
    });

    it("should return 404 if card not found", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      mockDb.returning.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/${boardId}/cards/card-1`, {
        method: "PUT",
        body: JSON.stringify({ title: "Updated Card" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(404);
    });
  });

  describe("POST /:boardId/cards/:cardId/move", () => {
    it("should move card to beginning of column", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      const existingCards = [
        { id: "card-2", columnId: "col-2", position: 1.0 },
        { id: "card-3", columnId: "col-2", position: 2.0 },
      ];
      mockDb.orderBy.mockResolvedValueOnce(existingCards);

      const updatedCard = { id: "card-1", columnId: "col-2", position: 0.5 };
      mockDb.limit.mockResolvedValueOnce([updatedCard]);

      const res = await app.request(`${baseUrl}/${boardId}/cards/card-1/move`, {
        method: "POST",
        body: JSON.stringify({ columnId: "col-2", afterCardId: null }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
    });

    it("should move card after another card", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      const existingCards = [
        { id: "card-2", columnId: "col-2", position: 1.0 },
        { id: "card-3", columnId: "col-2", position: 2.0 },
      ];
      mockDb.orderBy.mockResolvedValueOnce(existingCards);

      const updatedCard = { id: "card-1", columnId: "col-2", position: 1.5 };
      mockDb.limit.mockResolvedValueOnce([updatedCard]);

      const res = await app.request(`${baseUrl}/${boardId}/cards/card-1/move`, {
        method: "POST",
        body: JSON.stringify({ columnId: "col-2", afterCardId: "card-2" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
    });

    it("should trigger rebalancing when gap is too small", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      // Cards with very small gap between positions 1 and 2
      const existingCards = [
        { id: "card-2", columnId: "col-1", position: 1.0 },
        { id: "card-3", columnId: "col-1", position: 1.0000001 }, // gap < 0.001
      ];
      mockDb.orderBy.mockResolvedValueOnce(existingCards);

      const updatedCard = { id: "card-1", columnId: "col-1", position: 2.0 };
      mockDb.limit.mockResolvedValueOnce([updatedCard]);

      const res = await app.request(
        `${baseUrl}/${boardId}/cards/card-1/move`,
        {
          method: "POST",
          body: JSON.stringify({ columnId: "col-1", afterCardId: "card-2" }),
          headers: { "Content-Type": "application/json" },
        },
      );

      expect(res.status).toBe(200);
      expect(mockDb.transaction).toHaveBeenCalled();
    });

    it("should return 400 if afterCardId not found in column", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      const existingCards = [
        { id: "card-2", columnId: "col-2", position: 1.0 },
      ];
      mockDb.orderBy.mockResolvedValueOnce(existingCards);

      const res = await app.request(`${baseUrl}/${boardId}/cards/card-1/move`, {
        method: "POST",
        body: JSON.stringify({ columnId: "col-2", afterCardId: "non-existent" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toBe("afterCardId not found in column");
    });
  });

  describe("DELETE /:boardId/cards/:cardId - board membership", () => {
    it("should return 404 when card does not belong to board", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess
      mockDb.returning.mockResolvedValueOnce([]); // delete returns empty

      const res = await app.request(
        `${baseUrl}/${boardId}/cards/card-from-other-board`,
        {
          method: "DELETE",
        },
      );
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /:boardId/cards/:cardId", () => {
    it("should delete card", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      mockDb.returning.mockResolvedValueOnce([{ id: "card-1" }]);

      const res = await app.request(`${baseUrl}/${boardId}/cards/card-1`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Card deleted" });
    });

    it("should return 404 if card not found", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      mockDb.returning.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/${boardId}/cards/card-1`, {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });
  });

  // Card comments — shared constants
  const cardId = "card-1";
  const commentId = "comment-1";
  const commentsUrl = `${baseUrl}/${boardId}/cards/${cardId}/comments`;

  // A comment with null attribution avoids user/agent name-resolution queries
  const mockComment = {
    id: commentId,
    cardId,
    body: "Test comment",
    createdByUserId: null,
    createdByAgentId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  describe("GET /:boardId/cards/:cardId/comments", () => {
    it("should return 401 if not authenticated", async () => {
      mockNoSession();
      const res = await app.request(commentsUrl);
      expect(res.status).toBe(401);
    });

    it("should return 404 if card not found", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([]); // card verification → not found

      const res = await app.request(commentsUrl);
      expect(res.status).toBe(404);
    });

    it("should return comments for card with createdByName resolved", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([{ id: cardId }]); // card verification → found
      mockDb.orderBy.mockResolvedValueOnce([mockComment]); // comments query

      const res = await app.request(commentsUrl);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toHaveLength(1);
      expect(body.results[0].body).toBe("Test comment");
      expect(body.results[0].createdByName).toBeNull();
    });

    it("should return empty results when card has no comments", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([{ id: cardId }]); // card found
      mockDb.orderBy.mockResolvedValueOnce([]); // no comments

      const res = await app.request(commentsUrl);
      expect(res.status).toBe(200);
      expect((await res.json()).results).toHaveLength(0);
    });
  });

  describe("POST /:boardId/cards/:cardId/comments", () => {
    it("should return 401 if not authenticated", async () => {
      mockNoSession();
      const res = await app.request(commentsUrl, {
        method: "POST",
        body: JSON.stringify({ body: "A comment" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(401);
    });

    it("should return 404 if card not found", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([]); // card verification → not found

      const res = await app.request(commentsUrl, {
        method: "POST",
        body: JSON.stringify({ body: "A comment" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(404);
    });

    it("should create comment and return 201", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([{ id: cardId }]); // card found
      mockDb.returning.mockResolvedValueOnce([mockComment]); // insert

      const res = await app.request(commentsUrl, {
        method: "POST",
        body: JSON.stringify({ body: "Test comment" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.body).toBe("Test comment");
      expect(body.id).toBe(commentId);
    });

    it("should return 400 if body is empty string", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      const res = await app.request(commentsUrl, {
        method: "POST",
        body: JSON.stringify({ body: "" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(400);
    });

    it("should return 400 if body field is missing", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      const res = await app.request(commentsUrl, {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(400);
    });
  });

  describe("PUT /:boardId/cards/:cardId/comments/:commentId", () => {
    it("should return 401 if not authenticated", async () => {
      mockNoSession();
      const res = await app.request(`${commentsUrl}/${commentId}`, {
        method: "PUT",
        body: JSON.stringify({ body: "Updated" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(401);
    });

    it("should update comment and return enriched result", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      const updatedComment = { ...mockComment, body: "Updated" };
      mockDb.returning.mockResolvedValueOnce([updatedComment]); // update

      const res = await app.request(`${commentsUrl}/${commentId}`, {
        method: "PUT",
        body: JSON.stringify({ body: "Updated" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(200);
      expect((await res.json()).body).toBe("Updated");
    });

    it("should return 404 if comment not found", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess
      mockDb.returning.mockResolvedValueOnce([]); // not found

      const res = await app.request(`${commentsUrl}/${commentId}`, {
        method: "PUT",
        body: JSON.stringify({ body: "Updated" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /:boardId/cards/:cardId/comments/:commentId", () => {
    it("should return 401 if not authenticated", async () => {
      mockNoSession();
      const res = await app.request(`${commentsUrl}/${commentId}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(401);
    });

    it("should delete comment and return success", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess
      mockDb.returning.mockResolvedValueOnce([{ id: commentId }]); // delete

      const res = await app.request(`${commentsUrl}/${commentId}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
    });

    it("should return 404 if comment not found", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess
      mockDb.returning.mockResolvedValueOnce([]); // not found

      const res = await app.request(`${commentsUrl}/${commentId}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });
  });
});
