import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { mockDb, resetMockDb } from "../test-utils.ts";

vi.mock("../services/event-dispatch.ts", () => ({
  dispatchEvent: vi.fn(),
}));

import { createKanbanTools } from "./kanban.ts";

const ctx = { toolCallId: "test", messages: [] };
const workspaceId = "ws-1";
const agentId = "agent-1";
const orgId = "org-1";
const frontendUrl = "http://localhost:3000";

describe("createKanbanTools", () => {
  let tools: ReturnType<typeof createKanbanTools>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDb();
    tools = createKanbanTools(workspaceId, agentId, orgId, frontendUrl);
  });

  it("returns the expected tool names", () => {
    expect(Object.keys(tools)).toEqual([
      "listAgents",
      "listBoards",
      "getBoardState",
      "getCard",
      "upsertCard",
      "moveCard",
      "copyCard",
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

      expect(await tools.listBoards.execute!({}, ctx)).toEqual(boards);
    });
  });

  describe("getBoardState", () => {
    it("returns error when board not found", async () => {
      mockDb.limit.mockResolvedValue([]);

      expect(
        await tools.getBoardState.execute!(
          { boardId: "bad-id", label: "test" },
          ctx,
        ),
      ).toEqual({ error: "Board not found" });
    });
  });

  describe("getCard", () => {
    it("returns error when card not found (verifyCard fails)", async () => {
      mockDb.limit.mockResolvedValue([]);

      expect(
        await tools.getCard.execute!({ cardId: "bad-id", label: "test" }, ctx),
      ).toEqual({ error: "Card not found" });
    });
  });

  describe("upsertCard (create)", () => {
    it("returns error when columnId and title missing", async () => {
      expect(await tools.upsertCard.execute!({ label: "test" }, ctx)).toEqual({
        error: "columnId and title are required when creating a new card",
      });
    });

    it("returns error when column not found", async () => {
      mockDb.limit.mockResolvedValue([]);

      expect(
        await tools.upsertCard.execute!(
          { columnId: "bad-col", title: "Card", label: "test" },
          ctx,
        ),
      ).toEqual({ error: "Column not found" });
    });
  });

  describe("upsertCard (update)", () => {
    it("returns error when card not found during update", async () => {
      mockDb.limit.mockResolvedValue([]);

      expect(
        await tools.upsertCard.execute!(
          { cardId: "bad-id", title: "Updated", label: "test" },
          ctx,
        ),
      ).toEqual({ error: "Card not found" });
    });
  });

  describe("upsertCard (update) — bodyDiff", () => {
    function setupCardUpdate(existingBody: string, updatedCard: object) {
      // verifyCard returns a record (limit call #1), body select returns body (limit call #2),
      // update returning returns updated card, getBoardIdForCard returns boardId (limit call #3)
      mockDb.limit
        .mockResolvedValueOnce([{ id: "card-1" }]) // verifyCard
        .mockResolvedValueOnce([{ body: existingBody }]) // SELECT body
        .mockResolvedValueOnce([{ boardId: "board-1" }]); // getBoardIdForCard
      mockDb.returning.mockResolvedValueOnce([updatedCard]);
    }

    it("applies search-replace to existing body", async () => {
      setupCardUpdate("Hello world", { id: "card-1", body: "Hello there" });

      await tools.upsertCard.execute!(
        {
          cardId: "card-1",
          label: "test",
          bodyDiff: [{ search: "world", replace: "there" }],
        },
        ctx,
      );

      const setCall = mockDb.set.mock.calls[0][0] as { body: string };
      expect(setCall.body).toBe("Hello there");
    });

    it("returns error when search string not found", async () => {
      mockDb.limit
        .mockResolvedValueOnce([{ id: "card-1" }]) // verifyCard
        .mockResolvedValueOnce([{ body: "Hello world" }]); // SELECT body

      expect(
        await tools.upsertCard.execute!(
          {
            cardId: "card-1",
            label: "test",
            bodyDiff: [{ search: "missing text", replace: "replacement" }],
          },
          ctx,
        ),
      ).toEqual({
        error: 'bodyDiff search string not found: "missing text"',
      });
    });

    it("applies multiple search-replace operations sequentially", async () => {
      setupCardUpdate("foo bar baz", { id: "card-1", body: "qux quux baz" });

      await tools.upsertCard.execute!(
        {
          cardId: "card-1",
          label: "test",
          bodyDiff: [
            { search: "foo", replace: "qux" },
            { search: "bar", replace: "quux" },
          ],
        },
        ctx,
      );

      const setCall = mockDb.set.mock.calls[0][0] as { body: string };
      expect(setCall.body).toBe("qux quux baz");
    });

    it("appends content to existing body", async () => {
      setupCardUpdate("existing content", {
        id: "card-1",
        body: "existing content\nnew line",
      });

      await tools.upsertCard.execute!(
        {
          cardId: "card-1",
          label: "test",
          bodyDiff: { mode: "append", content: "\nnew line" },
        },
        ctx,
      );

      const setCall = mockDb.set.mock.calls[0][0] as { body: string };
      expect(setCall.body).toBe("existing content\nnew line");
    });

    it("prepends content to existing body", async () => {
      setupCardUpdate("existing content", {
        id: "card-1",
        body: "new line\nexisting content",
      });

      await tools.upsertCard.execute!(
        {
          cardId: "card-1",
          label: "test",
          bodyDiff: { mode: "prepend", content: "new line\n" },
        },
        ctx,
      );

      const setCall = mockDb.set.mock.calls[0][0] as { body: string };
      expect(setCall.body).toBe("new line\nexisting content");
    });

    it("rejects when both body and bodyDiff are provided", () => {
      const schema = tools.upsertCard.inputSchema as z.ZodType;
      const result = schema.safeParse({
        cardId: "card-1",
        label: "test",
        body: "full body",
        bodyDiff: [{ search: "foo", replace: "bar" }],
      });

      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toBe(
        "body and bodyDiff are mutually exclusive",
      );
    });
  });

  describe("moveCard", () => {
    it("returns error when card not found", async () => {
      mockDb.limit.mockResolvedValue([]);

      expect(
        await tools.moveCard.execute!(
          {
            cardId: "bad-id",
            columnId: "col-1",
            afterCardId: null,
            label: "test",
          },
          ctx,
        ),
      ).toEqual({ error: "Card not found" });
    });
  });

  describe("copyCard", () => {
    it("copies a card to a column on the same board", async () => {
      const sourceCard = {
        id: "card-1",
        columnId: "col-1",
        title: "Source Card",
        body: "Card body",
        labelIds: ["label-1"],
        assignees: [],
        dueDate: null,
        priority: "medium",
        position: 1,
      };
      const newCard = { ...sourceCard, id: "new-card-id", columnId: "col-2" };

      mockDb.limit
        .mockResolvedValueOnce([{ id: "card-1" }]) // verifyCard
        .mockResolvedValueOnce([{ id: "col-2" }]) // verifyColumn
        .mockResolvedValueOnce([{ boardId: "board-1" }]) // getBoardIdForCard
        .mockResolvedValueOnce([{ boardId: "board-1" }]) // target column boardId
        .mockResolvedValueOnce([sourceCard]); // source card select
      // Skip non-terminal where() calls, then resolve terminal where() for max position
      for (let i = 0; i < 5; i++) mockDb.where.mockReturnValueOnce(mockDb);
      mockDb.where.mockResolvedValueOnce([{ maxPos: 3 }]);
      mockDb.returning.mockResolvedValueOnce([newCard]);

      const result = (await tools.copyCard.execute!(
        { cardId: "card-1", columnId: "col-2", label: "Source Card" },
        ctx,
      )) as { error?: string; url?: string };

      expect(result).not.toHaveProperty("error");
      expect(result).toHaveProperty("url");
    });

    it("copies a card with comments when includeComments is true", async () => {
      const sourceCard = {
        id: "card-1",
        columnId: "col-1",
        title: "Source Card",
        body: "Body",
        labelIds: [],
        assignees: [],
        dueDate: null,
        priority: "none",
        position: 1,
      };
      const newCard = { ...sourceCard, id: "new-card-id" };
      const comments = [
        { id: "comment-1", cardId: "card-1", body: "Comment 1" },
      ];

      mockDb.limit
        .mockResolvedValueOnce([{ id: "card-1" }]) // verifyCard
        .mockResolvedValueOnce([{ id: "col-1" }]) // verifyColumn
        .mockResolvedValueOnce([{ boardId: "board-1" }]) // getBoardIdForCard
        .mockResolvedValueOnce([{ boardId: "board-1" }]) // target column boardId
        .mockResolvedValueOnce([sourceCard]); // source card select
      // Skip non-terminal where() calls, then resolve terminal where() for max position
      for (let i = 0; i < 5; i++) mockDb.where.mockReturnValueOnce(mockDb);
      mockDb.where.mockResolvedValueOnce([{ maxPos: 1 }]);
      mockDb.returning.mockResolvedValueOnce([newCard]);
      // comments query (orderBy resolves)
      mockDb.orderBy.mockResolvedValueOnce(comments);

      const result = (await tools.copyCard.execute!(
        {
          cardId: "card-1",
          columnId: "col-1",
          includeComments: true,
          label: "Source Card",
        },
        ctx,
      )) as { error?: string };

      expect(result).not.toHaveProperty("error");
      // insert called for the new card + once per comment
      expect(mockDb.insert).toHaveBeenCalledTimes(2);
    });

    it("returns error when source card not found", async () => {
      mockDb.limit.mockResolvedValue([]);

      expect(
        await tools.copyCard.execute!(
          { cardId: "bad-id", columnId: "col-1", label: "test" },
          ctx,
        ),
      ).toEqual({ error: "Card not found" });
    });

    it("returns error when target column not found", async () => {
      mockDb.limit
        .mockResolvedValueOnce([{ id: "card-1" }]) // verifyCard passes
        .mockResolvedValueOnce([]); // verifyColumn fails

      expect(
        await tools.copyCard.execute!(
          { cardId: "card-1", columnId: "bad-col", label: "test" },
          ctx,
        ),
      ).toEqual({ error: "Column not found" });
    });

    it("returns error when cross-board copy is attempted", async () => {
      mockDb.limit
        .mockResolvedValueOnce([{ id: "card-1" }]) // verifyCard
        .mockResolvedValueOnce([{ id: "col-2" }]) // verifyColumn
        .mockResolvedValueOnce([{ boardId: "board-1" }]) // getBoardIdForCard (source)
        .mockResolvedValueOnce([{ boardId: "board-2" }]); // target column boardId

      expect(
        await tools.copyCard.execute!(
          { cardId: "card-1", columnId: "col-2", label: "test" },
          ctx,
        ),
      ).toEqual({ error: "Cross-board copy is not allowed" });
    });
  });

  describe("deleteCard", () => {
    it("returns error when card not found", async () => {
      mockDb.limit.mockResolvedValue([]);

      expect(
        await tools.deleteCard.execute!(
          { cardIds: ["bad-id"], label: "test" },
          ctx,
        ),
      ).toEqual({ error: "Card not found: bad-id" });
    });
  });

  describe("upsertComment (create)", () => {
    it("returns error when cardId missing", async () => {
      expect(
        await tools.upsertComment.execute!(
          { body: "Comment text", label: "test" },
          ctx,
        ),
      ).toEqual({
        error: "cardId is required when creating a new comment",
      });
    });
  });

  describe("upsertComment (update)", () => {
    it("returns error when comment not found", async () => {
      mockDb.limit.mockResolvedValue([]);

      expect(
        await tools.upsertComment.execute!(
          { commentId: "bad-id", body: "Updated", label: "test" },
          ctx,
        ),
      ).toEqual({ error: "Comment not found" });
    });
  });

  describe("deleteComment", () => {
    it("returns error when comment not found", async () => {
      mockDb.limit.mockResolvedValue([]);

      expect(
        await tools.deleteComment.execute!(
          { commentId: "bad-id", label: "test" },
          ctx,
        ),
      ).toEqual({ error: "Comment not found" });
    });
  });
});
