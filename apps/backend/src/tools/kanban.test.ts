import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, dbMethods } = vi.hoisted(() => {
  const mock: any = {};
  const methods = [
    "select",
    "from",
    "where",
    "limit",
    "orderBy",
    "innerJoin",
    "insert",
    "values",
    "update",
    "set",
    "delete",
    "returning",
  ];
  methods.forEach((method) => {
    mock[method] = vi.fn().mockReturnValue(mock);
  });
  mock.transaction = vi.fn((cb: any) => cb(mock));
  return { mockDb: mock, dbMethods: methods };
});

vi.mock("../index.ts", () => ({
  db: mockDb,
}));

vi.mock("../services/event-dispatch.ts", () => ({
  dispatchEvent: vi.fn(),
}));

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual("drizzle-orm");
  return {
    ...actual,
    eq: vi.fn(),
    and: vi.fn((...args) => args.filter(Boolean)),
    inArray: vi.fn(),
    asc: vi.fn(),
    max: vi.fn(),
  };
});

import { createKanbanTools } from "./kanban.ts";

const ctx = { toolCallId: "test", messages: [] };
const workspaceId = "ws-1";
const agentId = "agent-1";
const orgId = "org-1";
const frontendUrl = "http://localhost:3000";

function resetDb() {
  dbMethods.forEach((method) => {
    mockDb[method] = vi.fn().mockReturnValue(mockDb);
  });
  mockDb.transaction = vi.fn((cb: any) => cb(mockDb));
}

describe("createKanbanTools", () => {
  let tools: ReturnType<typeof createKanbanTools>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetDb();
    tools = createKanbanTools(workspaceId, agentId, orgId, frontendUrl);
  });

  it("returns the expected tool names", () => {
    expect(Object.keys(tools)).toEqual([
      "listBoards",
      "getBoardState",
      "getCard",
      "upsertCard",
      "moveCard",
      "deleteCard",
      "bulkEditCards",
      "listComments",
      "upsertComment",
      "deleteComment",
    ]);
  });

  describe("listBoards", () => {
    it("returns boards in workspace", async () => {
      const boards = [{ id: "b1", name: "Board 1" }];
      mockDb.where.mockResolvedValue(boards);

      const result = await tools.listBoards.execute({}, ctx);
      expect(result).toEqual(boards);
    });
  });

  describe("getBoardState", () => {
    it("returns error when board not found", async () => {
      mockDb.limit.mockResolvedValue([]);

      const result = await tools.getBoardState.execute(
        { boardId: "bad-id", label: "test" },
        ctx,
      );
      expect(result).toEqual({ error: "Board not found" });
    });
  });

  describe("getCard", () => {
    it("returns error when card not found (verifyCard fails)", async () => {
      mockDb.limit.mockResolvedValue([]);

      const result = await tools.getCard.execute(
        { cardId: "bad-id", label: "test" },
        ctx,
      );
      expect(result).toEqual({ error: "Card not found" });
    });
  });

  describe("upsertCard (create)", () => {
    it("returns error when columnId and title missing", async () => {
      const result = await tools.upsertCard.execute({ label: "test" }, ctx);
      expect(result).toEqual({
        error: "columnId and title are required when creating a new card",
      });
    });

    it("returns error when column not found", async () => {
      mockDb.limit.mockResolvedValue([]);

      const result = await tools.upsertCard.execute(
        { columnId: "bad-col", title: "Card", label: "test" },
        ctx,
      );
      expect(result).toEqual({ error: "Column not found" });
    });
  });

  describe("upsertCard (update)", () => {
    it("returns error when card not found during update", async () => {
      mockDb.limit.mockResolvedValue([]);

      const result = await tools.upsertCard.execute(
        { cardId: "bad-id", title: "Updated", label: "test" },
        ctx,
      );
      expect(result).toEqual({ error: "Card not found" });
    });
  });

  describe("moveCard", () => {
    it("returns error when card not found", async () => {
      mockDb.limit.mockResolvedValue([]);

      const result = await tools.moveCard.execute(
        {
          cardId: "bad-id",
          columnId: "col-1",
          afterCardId: null,
          label: "test",
        },
        ctx,
      );
      expect(result).toEqual({ error: "Card not found" });
    });
  });

  describe("deleteCard", () => {
    it("returns error when card not found", async () => {
      mockDb.limit.mockResolvedValue([]);

      const result = await tools.deleteCard.execute(
        { cardIds: ["bad-id"], label: "test" },
        ctx,
      );
      expect(result).toEqual({ error: "Card not found: bad-id" });
    });
  });

  describe("upsertComment (create)", () => {
    it("returns error when cardId missing", async () => {
      const result = await tools.upsertComment.execute(
        { body: "Comment text", label: "test" },
        ctx,
      );
      expect(result).toEqual({
        error: "cardId is required when creating a new comment",
      });
    });
  });

  describe("upsertComment (update)", () => {
    it("returns error when comment not found", async () => {
      mockDb.limit.mockResolvedValue([]);

      const result = await tools.upsertComment.execute(
        { commentId: "bad-id", body: "Updated", label: "test" },
        ctx,
      );
      expect(result).toEqual({ error: "Comment not found" });
    });
  });

  describe("deleteComment", () => {
    it("returns error when comment not found", async () => {
      mockDb.limit.mockResolvedValue([]);

      const result = await tools.deleteComment.execute(
        { commentId: "bad-id", label: "test" },
        ctx,
      );
      expect(result).toEqual({ error: "Comment not found" });
    });
  });
});
