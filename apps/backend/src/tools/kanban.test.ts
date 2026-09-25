import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
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

  /** Two Workspaces, each with a Board, over the fake that reads `WHERE`s. */
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

    // History is opt-in: most reads want what the card says now, and the flag
    // is what keeps the common call from paying for a past it will not use.
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
        ]) // card guard
        .mockResolvedValueOnce([{ id: "card-1", title: "Card" }]) // the card row
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", boardId: "board-1" },
        ]) // card guard again, inside the history read
        .mockResolvedValueOnce([entry]); // the entries
      // Only the actor-name lookup terminates at where(); the chains before it
      // have to stay chainable.
      for (let i = 0; i < 4; i++) mockDb.where.mockReturnValueOnce(mockDb);
      mockDb.where.mockResolvedValueOnce([
        { id: "agent-1", name: "Triage bot" },
      ]); // the actor's name

      const result = (await tools.getCard.execute!(
        { cardId: "card-1", label: "test", includeHistory: true },
        ctx,
      )) as { history?: { actorName: string | null }[] };

      expect(result.history).toEqual([
        expect.objectContaining({ id: "hist-1", actorName: "Triage bot" }),
      ]);
    });
  });

  describe("upsertCard (create)", () => {
    it("returns error when columnId and title missing", async () => {
      expect(await tools.upsertCard.execute!({ label: "test" }, ctx)).toEqual({
        error: "columnId and title are required when creating a new card",
      });
    });

    it("does not create in another Workspace's column", async () => {
      const db = seedBoards();

      expect(
        await callTool(tools.upsertCard, {
          columnId: "col-other",
          title: "Card",
          label: "test",
        }),
      ).toEqual({ error: "Column not found" });
      expect(db.tables.kanban_card).toHaveLength(3);
    });
  });

  describe("upsertCard (update)", () => {
    it("does not reach another Workspace's card", async () => {
      const db = seedBoards();

      expect(
        await callTool(tools.upsertCard, {
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

  // Every diff mode is unit-tested on `applyBodyDiff` in services/kanban.test.ts;
  // here, that the tool applies one to the stored body and reports a stale one.
  describe("upsertCard (update) — bodyDiff", () => {
    it("applies the diff to the card's stored body", async () => {
      const db = seedBoards();

      await callOkTool(tools.upsertCard, {
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
        await callTool(tools.upsertCard, {
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

  // The Tool surface enforces the same label and assignee rules as the HTTP
  // surface: both go through the Kanban module, so an Agent cannot write a
  // label the board does not have or an assignee who cannot work here.
  describe("upsertCard — label and assignee rules", () => {
    it("rejects an unknown label ID when creating", async () => {
      mockDb.limit
        .mockResolvedValueOnce([{ id: "col-1", boardId: "board-1" }]) // column guard
        .mockResolvedValueOnce([{ labels: [{ id: "lbl-a" }] }]); // board labels

      expect(
        await tools.upsertCard.execute!(
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
      mockDb.limit.mockResolvedValueOnce([{ id: "col-1", boardId: "board-1" }]); // column guard
      mockDb.where.mockReturnValueOnce(mockDb); // column guard chain
      mockDb.where.mockResolvedValueOnce([]); // org member lookup — not found
      mockDb.where.mockResolvedValueOnce([]); // super admin lookup — not found

      expect(
        await tools.upsertCard.execute!(
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
      mockDb.limit.mockResolvedValueOnce([{ id: "col-1", boardId: "board-1" }]); // column guard
      mockDb.where.mockReturnValueOnce(mockDb); // column guard chain
      mockDb.where.mockResolvedValueOnce([]); // no workspace-scoped agent
      mockDb.where.mockResolvedValueOnce([]); // no attached org-scoped agent

      expect(
        await tools.upsertCard.execute!(
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
        ]) // card guard
        .mockResolvedValueOnce([{ id: "card-1", columnId: "col-1" }]) // prior row, for the changedFields value-diff
        .mockResolvedValueOnce([{ labels: [{ id: "lbl-a" }] }]) // board labels
        .mockResolvedValueOnce([{ labels: [{ id: "lbl-a", name: "A" }] }]) // board labels again, for the history entry's name snapshot
        .mockResolvedValueOnce([]); // the history trim's subquery
      // The written row carries the column it is already in: a `returning`
      // stub that omitted it would read as a column change to the value-diff.
      mockDb.returning.mockResolvedValueOnce([
        { id: "card-1", columnId: "col-1" },
      ]);

      await tools.upsertCard.execute!(
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
        ]) // card guard
        .mockResolvedValueOnce([{ id: "card-1", columnId: "col-1" }]); // prior row, for the changedFields value-diff
      mockDb.where.mockReturnValueOnce(mockDb); // card guard chain
      mockDb.where.mockReturnValueOnce(mockDb); // currentCardRow chain
      mockDb.where.mockResolvedValueOnce([]); // org member lookup — not found
      mockDb.where.mockResolvedValueOnce([]); // super admin lookup — not found

      expect(
        await tools.upsertCard.execute!(
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

    // A bulk edit works over cards that already exist, so it follows the
    // update rule: an unknown label is dropped rather than failing the batch.
    it("drops unknown label IDs", async () => {
      mockDb.limit
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", boardId: "board-1" },
        ]) // card guard
        .mockResolvedValueOnce([{ id: "card-1", columnId: "col-1" }]) // prior row, for the changedFields value-diff
        .mockResolvedValueOnce([{ labels: [{ id: "lbl-a" }] }]) // board labels
        .mockResolvedValueOnce([{ labels: [{ id: "lbl-a", name: "A" }] }]) // board labels again, for the history entry's name snapshot
        .mockResolvedValueOnce([]); // the history trim's subquery
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
      mockDb.where.mockResolvedValueOnce([]); // org member lookup — not found
      mockDb.where.mockResolvedValueOnce([]); // super admin lookup — not found

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

    // A refused precondition has to reach the model as a readable result. If it
    // escaped `asToolResult` it would throw into the run instead, which is a
    // failed run rather than an agent that re-reads and carries on.
    it("reports a refused expected column back to the model", async () => {
      mockDb.limit
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-now", boardId: "board-1" },
        ]) // requireCard
        .mockResolvedValueOnce([{ id: "col-target", boardId: "board-1" }]); // requireColumn
      mockDb.orderBy.mockResolvedValue([]); // placeCardInColumn
      mockDb.returning.mockResolvedValue([]); // the predicate matched no row

      // The message is asserted whole: it must name the problem without naming
      // the column the card is now in. `col-now` above is the current column,
      // and it does not appear here.
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
        ]) // card guard
        .mockResolvedValueOnce([{ id: "col-2", boardId: "board-1" }]) // column guard
        .mockResolvedValueOnce([sourceCard]) // source card select
        .mockResolvedValueOnce([{ id: "col-2", name: "Doing" }]) // the copy's created entry snapshots its column name
        .mockResolvedValueOnce([]); // the history trim's subquery
      // Skip non-terminal where() calls, then resolve terminal where() for max position
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
        ]) // card guard
        .mockResolvedValueOnce([{ id: "col-1", boardId: "board-1" }]) // column guard
        .mockResolvedValueOnce([sourceCard]) // source card select
        .mockResolvedValueOnce([{ id: "col-2", name: "Doing" }]) // the copy's created entry snapshots its column name
        .mockResolvedValueOnce([]); // the history trim's subquery
      // Skip non-terminal where() calls, then resolve terminal where() for max position
      for (let i = 0; i < 3; i++) mockDb.where.mockReturnValueOnce(mockDb);
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
      // insert called for the new card, once per comment, and once for the
      // copy's own `created` history entry
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
        ]) // card guard passes
        .mockResolvedValueOnce([]); // column guard fails

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
        ]) // card guard (source)
        .mockResolvedValueOnce([{ id: "col-2", boardId: "board-2" }]); // column guard (target)

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

    it("upsertComment creates a comment attributed to this agent", async () => {
      const db = seedBoards();

      const result: unknown = await callTool(tools.upsertComment, {
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

    it("upsertComment requires a cardId to create", async () => {
      expect(
        await callTool(tools.upsertComment, {
          body: "Comment text",
          label: "test",
        }),
      ).toEqual({ error: "cardId is required when creating a new comment" });
    });

    it("upsertComment updates a comment's body by commentId", async () => {
      const db = seedBoards();

      expect(
        await callTool(tools.upsertComment, {
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
        "upsertComment create",
        () =>
          callTool(tools.upsertComment, {
            cardId: "card-other",
            body: "x",
            label: "x",
          }),
        "Card not found",
      ],
      [
        "upsertComment update",
        () =>
          callTool(tools.upsertComment, {
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
