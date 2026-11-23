import { describe, it, expect, vi, beforeEach } from "vitest";
import type { z } from "zod";
import {
  callOkTool,
  callTool,
  mockDb,
  resetMockDb,
  seedDb,
} from "../test-utils.ts";

vi.mock("../services/event-dispatch.ts", () => ({
  dispatchEvent: vi.fn(),
}));

import { createKanbanTools } from "./kanban.ts";

const ctx = { toolCallId: "test", messages: [], context: {} };
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
      "createCard",
      "updateCard",
      "moveCard",
      "copyCard",
      "deleteCard",
      "bulkEditCards",
      "listComments",
      "createComment",
      "updateComment",
      "deleteComment",
    ]);
  });

  const comment = (
    id: string,
    cardId: string,
    createdAt: string,
    by: { user?: string; agent?: string },
  ) => ({
    id,
    cardId,
    body: `${id} body`,
    createdByUserId: by.user ?? null,
    createdByAgentId: by.agent ?? null,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
  });

  const seedBoards = () =>
    seedDb({
      kanban_board: [
        {
          id: "b1",
          workspaceId,
          name: "Older",
          description: null,
          labels: [{ id: "lbl-1", name: "Bug", color: "#ef4444" }],
          createdAt: new Date("2026-01-01"),
          updatedAt: new Date("2026-01-01"),
        },
        {
          id: "b2",
          workspaceId,
          name: "Newer",
          description: "Second",
          labels: [],
          createdAt: new Date("2026-02-01"),
          updatedAt: new Date("2026-02-01"),
        },
        {
          id: "b-other",
          workspaceId: "ws-2",
          name: "Theirs",
          description: null,
          labels: [],
          createdAt: new Date("2026-03-01"),
          updatedAt: new Date("2026-03-01"),
        },
      ],
      kanban_column: [
        { id: "col-2", boardId: "b1", name: "Done", position: 2 },
        { id: "col-1", boardId: "b1", name: "To Do", position: 1 },
        { id: "col-other", boardId: "b-other", name: "To Do", position: 1 },
      ],
      kanban_card: [
        {
          id: "card-2",
          columnId: "col-1",
          title: "Second",
          body: "A long body the summary leaves out",
          position: 2,
          labelIds: [],
          assignees: [],
          dueDate: null,
          priority: "none",
          createdByUserId: "user-1",
          updatedAt: new Date("2026-05-02"),
        },
        {
          id: "card-1",
          columnId: "col-1",
          title: "First",
          body: null,
          position: 1,
          labelIds: ["lbl-1"],
          assignees: [{ type: "agent", id: "agent-1" }],
          dueDate: new Date("2026-04-01"),
          priority: "high",
          createdByUserId: "user-1",
          updatedAt: new Date("2026-05-01"),
        },
        {
          id: "card-other",
          columnId: "col-other",
          title: "Theirs",
          position: 1,
          labelIds: [],
          assignees: [],
          dueDate: null,
          priority: "none",
        },
      ],
      kanban_card_comment: [
        comment("comment-2", "card-1", "2026-01-03", { agent: "agent-1" }),
        comment("comment-1", "card-1", "2026-01-02", { user: "user-1" }),
        comment("comment-other", "card-other", "2026-01-01", {
          user: "user-1",
        }),
      ],
      user: [{ id: "user-1", name: "Alice" }],
      agent: [{ id: "agent-1", name: "Helper", workspaceId }],
    });

  describe("listBoards", () => {
    it("lists this Workspace's boards, newest first, trimmed to a summary", async () => {
      seedBoards();

      expect(await callTool(tools.listBoards, {})).toEqual([
        {
          id: "b2",
          name: "Newer",
          description: "Second",
          labels: [],
          createdAt: new Date("2026-02-01"),
        },
        {
          id: "b1",
          name: "Older",
          description: null,
          labels: [{ id: "lbl-1", name: "Bug", color: "#ef4444" }],
          createdAt: new Date("2026-01-01"),
        },
      ]);
    });
  });

  describe("getBoardState", () => {
    it("does not reach another Workspace's board", async () => {
      seedBoards();

      expect(
        await callTool(tools.getBoardState, {
          boardId: "b-other",
          label: "Theirs",
        }),
      ).toEqual({ error: "Board not found" });
    });

    it("returns ordered columns with card summaries, labels and a link", async () => {
      seedBoards();

      const state: unknown = await callOkTool(tools.getBoardState, {
        boardId: "b1",
        label: "Older",
      });

      expect(state).toEqual({
        board: expect.objectContaining({ id: "b1", name: "Older" }) as unknown,
        columns: [
          {
            id: "col-1",
            boardId: "b1",
            name: "To Do",
            position: 1,
            cards: [
              {
                id: "card-1",
                columnId: "col-1",
                title: "First",
                position: 1,
                labelIds: ["lbl-1"],
                assignees: [{ type: "agent", id: "agent-1" }],
                dueDate: new Date("2026-04-01"),
                priority: "high",
                updatedAt: new Date("2026-05-01"),
              },
              {
                id: "card-2",
                columnId: "col-1",
                title: "Second",
                position: 2,
                labelIds: [],
                assignees: [],
                dueDate: null,
                priority: "none",
                updatedAt: new Date("2026-05-02"),
              },
            ],
          },
          { id: "col-2", boardId: "b1", name: "Done", position: 2, cards: [] },
        ],
        labels: [{ id: "lbl-1", name: "Bug", color: "#ef4444" }],
        url: `${frontendUrl}/${orgId}/workspace/${workspaceId}/boards/b1`,
      });
    });
  });

  describe("getCard", () => {
    it("does not reach another Workspace's card", async () => {
      seedBoards();

      expect(
        await callTool(tools.getCard, { cardId: "card-other", label: "x" }),
      ).toEqual({ error: "Card not found" });
    });

    it("omits the history unless it is asked for", async () => {
      seedBoards();

      const result: unknown = await callTool(tools.getCard, {
        cardId: "card-1",
        label: "test",
      });

      expect(result).toMatchObject({ id: "card-1", title: "First" });
      expect(result).not.toHaveProperty("history");
    });

    it("returns the card's history when includeHistory is set", async () => {
      const entry = {
        id: "hist-1",
        cardId: "card-1",
        kind: "updated",
        changes: [{ field: "title", before: "Old", after: "New" }],
        actorUserId: null,
        actorAgentId: "agent-1",
        createdAt: new Date(),
      };
      mockDb.limit
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", boardId: "board-1" },
        ])
        .mockResolvedValueOnce([{ id: "card-1", title: "Card" }])
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", boardId: "board-1" },
        ])
        .mockResolvedValueOnce([entry]);
      for (let i = 0; i < 4; i++) mockDb.where.mockReturnValueOnce(mockDb);
      mockDb.where.mockResolvedValueOnce([
        { id: "agent-1", name: "Triage bot" },
      ]);

      const result = (await tools.getCard.execute!(
        { cardId: "card-1", label: "test", includeHistory: true },
        ctx,
      )) as { history?: { actorName: string | null }[] };

      expect(result.history).toEqual([
        expect.objectContaining({ id: "hist-1", actorName: "Triage bot" }),
      ]);
    });
  });

  describe("createCard", () => {
    it.each(["columnId", "title"] as const)(
      "refuses a create without %s",
      (field) => {
        const input: Record<string, unknown> = {
          columnId: "col-1",
          title: "Card",
          label: "test",
        };
        delete input[field];

        expect(
          (tools.createCard.inputSchema as z.ZodType).safeParse(input).success,
        ).toBe(false);
      },
    );

    it("does not create in another Workspace's column", async () => {
      const db = seedBoards();

      expect(
        await callTool(tools.createCard, {
          columnId: "col-other",
          title: "Card",
          label: "test",
        }),
      ).toEqual({ error: "Column not found" });
      expect(db.tables.kanban_card).toHaveLength(3);
    });
  });

  describe("updateCard", () => {
    it("does not reach another Workspace's card", async () => {
      const db = seedBoards();

      expect(
        await callTool(tools.updateCard, {
          cardId: "card-other",
          title: "Updated",
          label: "test",
        }),
      ).toEqual({ error: "Card not found" });
      expect(
        db.tables.kanban_card.find((c) => c.id === "card-other"),
      ).toMatchObject({ title: "Theirs" });
    });
  });

  describe("updateCard — bodyDiff", () => {
    it("applies the diff to the card's stored body", async () => {
      const db = seedBoards();

      await callOkTool(tools.updateCard, {
        cardId: "card-2",
        label: "test",
        bodyDiff: [{ search: "long body", replace: "short body" }],
      });

      expect(db.tables.kanban_card.find((c) => c.id === "card-2")?.body).toBe(
        "A short body the summary leaves out",
      );
    });

    it("reports a search string the body does not contain", async () => {
      const db = seedBoards();

      expect(
        await callTool(tools.updateCard, {
          cardId: "card-2",
          label: "test",
          bodyDiff: [{ search: "missing text", replace: "replacement" }],
        }),
      ).toEqual({
        error: 'bodyDiff search string not found: "missing text"',
      });
      expect(db.tables.kanban_card.find((c) => c.id === "card-2")?.body).toBe(
        "A long body the summary leaves out",
      );
    });

    it("rejects when both body and bodyDiff are provided", () => {
      const schema = tools.updateCard.inputSchema as z.ZodType;
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

  describe("card writes — label and assignee rules", () => {
    it("rejects an unknown label ID when creating", async () => {
      mockDb.limit
        .mockResolvedValueOnce([{ id: "col-1", boardId: "board-1" }])
        .mockResolvedValueOnce([{ labels: [{ id: "lbl-a" }] }]);

      expect(
        await tools.createCard.execute!(
          {
            columnId: "col-1",
            title: "Card",
            labelIds: ["lbl-a", "lbl-ghost"],
            label: "test",
          },
          ctx,
        ),
      ).toEqual({ error: "Invalid label ID" });
    });

    it("rejects a user assignee who is not an org member when creating", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: "col-1", boardId: "board-1" }]);
      mockDb.where.mockReturnValueOnce(mockDb);
      mockDb.where.mockResolvedValueOnce([]);
      mockDb.where.mockResolvedValueOnce([]);

      expect(
        await tools.createCard.execute!(
          {
            columnId: "col-1",
            title: "Card",
            assignees: [{ type: "user", id: "outsider" }],
            label: "test",
          },
          ctx,
        ),
      ).toEqual({ error: "Invalid user assignee" });
    });

    it("rejects an agent that is not visible in this workspace when creating", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: "col-1", boardId: "board-1" }]);
      mockDb.where.mockReturnValueOnce(mockDb);
      mockDb.where.mockResolvedValueOnce([]);
      mockDb.where.mockResolvedValueOnce([]);

      expect(
        await tools.createCard.execute!(
          {
            columnId: "col-1",
            title: "Card",
            assignees: [{ type: "agent", id: "someone-elses-agent" }],
            label: "test",
          },
          ctx,
        ),
      ).toEqual({ error: "Invalid agent assignee" });
    });

    it("drops unknown label IDs when updating", async () => {
      mockDb.limit
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", boardId: "board-1" },
        ])
        .mockResolvedValueOnce([{ id: "card-1", columnId: "col-1" }])
        .mockResolvedValueOnce([{ labels: [{ id: "lbl-a" }] }])
        .mockResolvedValueOnce([{ labels: [{ id: "lbl-a", name: "A" }] }])
        .mockResolvedValueOnce([]);
      mockDb.returning.mockResolvedValueOnce([
        { id: "card-1", columnId: "col-1" },
      ]);

      await tools.updateCard.execute!(
        {
          cardId: "card-1",
          labelIds: ["lbl-ghost", "lbl-a"],
          label: "test",
        },
        ctx,
      );

      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({ labelIds: ["lbl-a"] }),
      );
    });

    it("rejects an invalid assignee when updating", async () => {
      mockDb.limit
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", boardId: "board-1" },
        ])
        .mockResolvedValueOnce([{ id: "card-1", columnId: "col-1" }]);
      mockDb.where.mockReturnValueOnce(mockDb);
      mockDb.where.mockReturnValueOnce(mockDb);
      mockDb.where.mockResolvedValueOnce([]);
      mockDb.where.mockResolvedValueOnce([]);

      expect(
        await tools.updateCard.execute!(
          {
            cardId: "card-1",
            assignees: [{ type: "user", id: "outsider" }],
            label: "test",
          },
          ctx,
        ),
      ).toEqual({ error: "Invalid user assignee" });
    });
  });

  describe("bulkEditCards — label and assignee rules", () => {
    it.each([{ addLabelIds: ["lbl-1"] }, { removeLabelIds: ["lbl-1"] }])(
      "rejects labelIds alongside %o",
      (edit) => {
        const result = (tools.bulkEditCards.inputSchema as z.ZodType).safeParse(
          {
            cardIds: ["card-1"],
            label: "test",
            labelIds: ["lbl-1"],
            ...edit,
          },
        );

        expect(result.error?.issues[0]?.message).toBe(
          "labelIds is mutually exclusive with addLabelIds and removeLabelIds",
        );
      },
    );

    it("drops unknown label IDs", async () => {
      mockDb.limit
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", boardId: "board-1" },
        ])
        .mockResolvedValueOnce([{ id: "card-1", columnId: "col-1" }])
        .mockResolvedValueOnce([{ labels: [{ id: "lbl-a" }] }])
        .mockResolvedValueOnce([{ labels: [{ id: "lbl-a", name: "A" }] }])
        .mockResolvedValueOnce([]);
      mockDb.returning.mockResolvedValueOnce([
        { id: "card-1", columnId: "col-1" },
      ]);

      await tools.bulkEditCards.execute!(
        {
          cardIds: ["card-1"],
          labelIds: ["lbl-ghost", "lbl-a"],
          label: "test",
        },
        ctx,
      );

      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({ labelIds: ["lbl-a"] }),
      );
    });

    it("rejects an invalid assignee", async () => {
      mockDb.where.mockResolvedValueOnce([]);
      mockDb.where.mockResolvedValueOnce([]);

      expect(
        await tools.bulkEditCards.execute!(
          {
            cardIds: ["card-1"],
            assignees: [{ type: "user", id: "outsider" }],
            label: "test",
          },
          ctx,
        ),
      ).toEqual({ error: "Invalid user assignee" });
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

    it("reports a refused expected column back to the model", async () => {
      mockDb.limit
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-now", boardId: "board-1" },
        ])
        .mockResolvedValueOnce([{ id: "col-target", boardId: "board-1" }]);
      mockDb.orderBy.mockResolvedValue([]);
      mockDb.returning.mockResolvedValue([]);

      expect(
        await callTool(
          tools.moveCard,
          {
            cardId: "card-1",
            columnId: "col-target",
            afterCardId: null,
            label: "test",
            expectedColumnId: "col-stale",
          },
          ctx,
        ),
      ).toEqual({
        error:
          "Card is no longer in the expected column; re-read it before moving it",
      });
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
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", boardId: "board-1" },
        ])
        .mockResolvedValueOnce([{ id: "col-2", boardId: "board-1" }])
        .mockResolvedValueOnce([sourceCard])
        .mockResolvedValueOnce([{ id: "col-2", name: "Doing" }])
        .mockResolvedValueOnce([]);
      for (let i = 0; i < 3; i++) mockDb.where.mockReturnValueOnce(mockDb);
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
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", boardId: "board-1" },
        ])
        .mockResolvedValueOnce([{ id: "col-1", boardId: "board-1" }])
        .mockResolvedValueOnce([sourceCard])
        .mockResolvedValueOnce([{ id: "col-2", name: "Doing" }])
        .mockResolvedValueOnce([]);
      for (let i = 0; i < 3; i++) mockDb.where.mockReturnValueOnce(mockDb);
      mockDb.where.mockResolvedValueOnce([{ maxPos: 1 }]);
      mockDb.returning.mockResolvedValueOnce([newCard]);
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
      expect(mockDb.insert).toHaveBeenCalledTimes(3);
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
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", boardId: "board-1" },
        ])
        .mockResolvedValueOnce([]);

      expect(
        await tools.copyCard.execute!(
          { cardId: "card-1", columnId: "bad-col", label: "test" },
          ctx,
        ),
      ).toEqual({ error: "Column not found" });
    });

    it("returns error when cross-board copy is attempted", async () => {
      mockDb.limit
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", boardId: "board-1" },
        ])
        .mockResolvedValueOnce([{ id: "col-2", boardId: "board-2" }]);

      expect(
        await tools.copyCard.execute!(
          { cardId: "card-1", columnId: "col-2", label: "test" },
          ctx,
        ),
      ).toEqual({ error: "Cross-board copy is not allowed" });
    });
  });

  describe("deleteCard", () => {
    it("deletes this Workspace's cards", async () => {
      const db = seedBoards();

      expect(
        await callTool(tools.deleteCard, {
          cardIds: ["card-1", "card-2"],
          label: "First, Second",
        }),
      ).toEqual({ success: true });
      expect(db.tables.kanban_card.map((c) => c.id)).toEqual(["card-other"]);
    });

    it("deletes nothing when any card is out of reach, naming it", async () => {
      const db = seedBoards();

      expect(
        await callTool(tools.deleteCard, {
          cardIds: ["card-1", "card-other"],
          label: "test",
        }),
      ).toEqual({ error: "Card not found: card-other" });
      expect(db.tables.kanban_card).toHaveLength(3);
    });
  });

  describe("comments", () => {
    it("listComments returns a card's comments oldest first, with author names", async () => {
      seedBoards();

      expect(
        await callTool(tools.listComments, {
          cardId: "card-1",
          label: "First",
        }),
      ).toMatchObject([
        { id: "comment-1", createdByName: "Alice" },
        { id: "comment-2", createdByName: "Helper" },
      ]);
    });

    it("createComment adds a comment attributed to this agent", async () => {
      const db = seedBoards();

      const result: unknown = await callTool(tools.createComment, {
        cardId: "card-2",
        body: "Looks good",
        label: "test",
      });

      expect(result).toMatchObject({
        cardId: "card-2",
        body: "Looks good",
        createdByAgentId: agentId,
      });
      expect(db.tables.kanban_card_comment).toContainEqual(result);
    });

    it("createComment refuses to build without a cardId", () => {
      expect(
        (tools.createComment.inputSchema as z.ZodType).safeParse({
          body: "Comment text",
          label: "test",
        }).success,
      ).toBe(false);
    });

    it("updateComment replaces a comment's body by commentId", async () => {
      const db = seedBoards();

      expect(
        await callTool(tools.updateComment, {
          commentId: "comment-1",
          body: "Edited",
          label: "test",
        }),
      ).toMatchObject({ id: "comment-1", body: "Edited" });
      expect(
        db.tables.kanban_card_comment.find((c) => c.id === "comment-1")?.body,
      ).toBe("Edited");
    });

    it("deleteComment deletes a comment", async () => {
      const db = seedBoards();

      expect(
        await callTool(tools.deleteComment, {
          commentId: "comment-1",
          label: "test",
        }),
      ).toEqual({ success: true });
      expect(db.tables.kanban_card_comment.map((c) => c.id)).not.toContain(
        "comment-1",
      );
    });

    it.each([
      [
        "listComments",
        () =>
          callTool(tools.listComments, { cardId: "card-other", label: "x" }),
        "Card not found",
      ],
      [
        "createComment",
        () =>
          callTool(tools.createComment, {
            cardId: "card-other",
            body: "x",
            label: "x",
          }),
        "Card not found",
      ],
      [
        "updateComment",
        () =>
          callTool(tools.updateComment, {
            commentId: "comment-other",
            body: "x",
            label: "x",
          }),
        "Comment not found",
      ],
      [
        "deleteComment",
        () =>
          callTool(tools.deleteComment, {
            commentId: "comment-other",
            label: "x",
          }),
        "Comment not found",
      ],
    ])(
      "%s does not reach another Workspace's card",
      async (_name, call, error) => {
        const db = seedBoards();

        expect(await call()).toEqual({ error });
        expect(db.tables.kanban_card_comment).toHaveLength(3);
        expect(
          db.tables.kanban_card_comment.find((c) => c.id === "comment-other")
            ?.body,
        ).toBe("comment-other body");
      },
    );
  });
});
