import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockDb,
  mockSession,
  mockNoSession,
  resetMockDb,
  seedDb,
  type FakeDb,
} from "../test-utils.ts";
import app from "../server.ts";
import { mockNanoid } from "../test-setup.ts";

// Predictable IDs
mockNanoid.mockReturnValue("test-id-123");

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

  /**
   * The Board and Column routes run over `seedDb()`, which interprets each
   * query's `WHERE`, so these assert the status and body a request gets from
   * fixture rows rather than which query came back nth. The rules behind them
   * are the Kanban module's, tested in `services/kanban.boards.test.ts`; here
   * each status and body pair is pinned once.
   *
   * The caller (`user-1`) owns `ws-1` and its `board-1`; `board-b` lives in
   * `ws-2`, owned by someone else in the same Organization.
   */
  const boardWorld = (
    over: { owner?: string; cards?: Record<string, unknown>[] } = {},
  ): FakeDb =>
    seedDb({
      organization_member: [
        { id: "m1", userId: "user-1", organizationId: orgId, role: "member" },
      ],
      workspace: [
        {
          id: workspaceId,
          organizationId: orgId,
          ownerId: over.owner ?? "user-1",
        },
        { id: "ws-2", organizationId: orgId, ownerId: "other-user" },
      ],
      kanban_board: [
        {
          id: boardId,
          workspaceId,
          name: "Mine",
          description: null,
          labels: [{ id: "label-1", name: "Bug", color: "#ef4444" }],
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
        {
          id: "board-b",
          workspaceId: "ws-2",
          name: "Theirs",
          description: null,
          labels: [],
          createdAt: new Date("2026-01-02T00:00:00.000Z"),
          updatedAt: new Date("2026-01-02T00:00:00.000Z"),
        },
      ],
      kanban_column: [
        { id: "col-1", boardId, name: "To Do", position: 1 },
        { id: "col-2", boardId, name: "Done", position: 2 },
        { id: "col-b", boardId: "board-b", name: "To Do", position: 1 },
      ],
      kanban_card: over.cards ?? [],
      user: [{ id: "user-1", name: "Ada", image: null }],
    });

  const json = (method: string, body: unknown) => ({
    method,
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });

  describe("GET /", () => {
    it("should return 401 if not authenticated", async () => {
      mockNoSession();
      const res = await app.request(baseUrl);
      expect(res.status).toBe(401);
    });

    it("lists this Workspace's boards", async () => {
      boardWorld();
      mockSession();

      const res = await app.request(baseUrl);

      expect(res.status).toBe(200);
      const body = (await res.json()) as { results: { id: string }[] };
      expect(body.results.map((board) => board.id)).toEqual([boardId]);
    });
  });

  describe("POST /", () => {
    it("should return 401 if not authenticated", async () => {
      mockNoSession();
      const res = await app.request(baseUrl, json("POST", { name: "New" }));
      expect(res.status).toBe(401);
    });

    it("should return 403 if user is not workspace owner", async () => {
      boardWorld({ owner: "other-user" });
      mockSession();

      const res = await app.request(baseUrl, json("POST", { name: "New" }));
      expect(res.status).toBe(403);
    });

    it("creates the board with its default columns", async () => {
      const fake = boardWorld();
      mockSession();

      const res = await app.request(
        baseUrl,
        json("POST", { name: "New Board" }),
      );

      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({
        id: "test-id-123",
        name: "New Board",
        workspaceId,
      });
      expect(
        fake.tables.kanban_column
          .filter((col) => col.boardId === "test-id-123")
          .map((col) => col.name),
      ).toEqual(["To Do", "In Progress", "Done"]);
    });

    it("should return 400 if name is missing", async () => {
      boardWorld();
      mockSession();

      const res = await app.request(baseUrl, json("POST", {}));
      expect(res.status).toBe(400);
    });
  });

  describe("GET /:boardId", () => {
    it("returns 404 for another Workspace's board", async () => {
      boardWorld();
      mockSession();

      const res = await app.request(`${baseUrl}/board-b`);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Board not found" });
    });

    it("returns the board", async () => {
      boardWorld();
      mockSession();

      const res = await app.request(`${baseUrl}/${boardId}`);

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: boardId, name: "Mine" });
    });
  });

  describe("PUT /:boardId", () => {
    it("returns the updated board", async () => {
      boardWorld();
      mockSession();

      const res = await app.request(
        `${baseUrl}/${boardId}`,
        json("PUT", { name: "Updated Board" }),
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        id: boardId,
        name: "Updated Board",
      });
    });

    it("returns 404 for another Workspace's board", async () => {
      const fake = boardWorld();
      mockSession();

      const res = await app.request(
        `${baseUrl}/board-b`,
        json("PUT", { name: "Hijacked" }),
      );

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Board not found" });
      expect(fake.tables.kanban_board[1].name).toBe("Theirs");
    });
  });

  describe("DELETE /:boardId", () => {
    it("deletes the board", async () => {
      const fake = boardWorld();
      mockSession();

      const res = await app.request(`${baseUrl}/${boardId}`, {
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Board deleted" });
      expect(fake.tables.kanban_board.map((board) => board.id)).toEqual([
        "board-b",
      ]);
    });

    it("returns 404 for another Workspace's board", async () => {
      boardWorld();
      mockSession();

      const res = await app.request(`${baseUrl}/board-b`, {
        method: "DELETE",
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Board not found" });
    });
  });

  describe("GET /:boardId/state", () => {
    it("returns 404 for another Workspace's board", async () => {
      boardWorld();
      mockSession();

      const res = await app.request(`${baseUrl}/board-b/state`);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Board not found" });
    });

    // The whole body, because the frontend reads this shape
    // (`kanbanBoardStateSchema`) and it must not drift.
    it("returns the board with its columns and resolved cards", async () => {
      boardWorld({
        cards: [
          {
            id: "card-1",
            columnId: "col-1",
            title: "Card 1",
            body: null,
            labelIds: ["label-1"],
            assignees: [{ type: "user", id: "user-1" }],
            dueDate: new Date("2026-02-01T00:00:00.000Z"),
            priority: "high",
            position: 1,
            createdByUserId: "user-1",
            createdByAgentId: null,
            lastEditedByUserId: null,
            lastEditedByAgentId: null,
            createdAt: new Date("2026-01-03T00:00:00.000Z"),
            updatedAt: new Date("2026-01-03T00:00:00.000Z"),
          },
        ],
      });
      mockSession();

      const res = await app.request(`${baseUrl}/${boardId}/state`);

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        columns: { cards: Record<string, unknown>[] }[];
      };
      // `toEqual` ignores key order, so the order is pinned on its own.
      expect(Object.keys(body.columns[0].cards[0])).toEqual([
        "id",
        "columnId",
        "title",
        "body",
        "labelIds",
        "assignees",
        "dueDate",
        "priority",
        "position",
        "createdByUserId",
        "createdByAgentId",
        "lastEditedByUserId",
        "lastEditedByAgentId",
        "createdAt",
        "updatedAt",
        "createdByName",
        "lastEditedByName",
        "resolvedAssignees",
        "commentCount",
      ]);
      expect(body).toEqual({
        board: {
          id: boardId,
          workspaceId,
          name: "Mine",
          description: null,
          labels: [{ id: "label-1", name: "Bug", color: "#ef4444" }],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        columns: [
          {
            id: "col-1",
            boardId,
            name: "To Do",
            position: 1,
            cards: [
              {
                id: "card-1",
                columnId: "col-1",
                title: "Card 1",
                body: null,
                labelIds: ["label-1"],
                assignees: [{ type: "user", id: "user-1" }],
                dueDate: "2026-02-01T00:00:00.000Z",
                priority: "high",
                position: 1,
                createdByUserId: "user-1",
                createdByAgentId: null,
                lastEditedByUserId: null,
                lastEditedByAgentId: null,
                createdAt: "2026-01-03T00:00:00.000Z",
                updatedAt: "2026-01-03T00:00:00.000Z",
                createdByName: "Ada",
                lastEditedByName: null,
                resolvedAssignees: [
                  { type: "user", id: "user-1", name: "Ada", image: null },
                ],
                commentCount: 0,
              },
            ],
          },
          { id: "col-2", boardId, name: "Done", position: 2, cards: [] },
        ],
      });
    });
  });

  describe("POST /:boardId/columns", () => {
    it("returns 404 for another Workspace's board", async () => {
      boardWorld();
      mockSession();

      const res = await app.request(
        `${baseUrl}/board-b/columns`,
        json("POST", { name: "New Column" }),
      );

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Board not found" });
    });

    it("creates the column at the end of the board", async () => {
      boardWorld();
      mockSession();

      const res = await app.request(
        `${baseUrl}/${boardId}/columns`,
        json("POST", { name: "New Column" }),
      );

      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({
        id: "test-id-123",
        boardId,
        name: "New Column",
        position: 3,
      });
    });

    it("returns 409 if the board already has a column by that name", async () => {
      boardWorld();
      mockSession();

      const res = await app.request(
        `${baseUrl}/${boardId}/columns`,
        json("POST", { name: "Done" }),
      );

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "A column with this name already exists on the board",
      });
    });
  });

  describe("PUT /:boardId/columns/:columnId", () => {
    it("returns the renamed column", async () => {
      boardWorld();
      mockSession();

      const res = await app.request(
        `${baseUrl}/${boardId}/columns/col-1`,
        json("PUT", { name: "Updated Column" }),
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        id: "col-1",
        boardId,
        name: "Updated Column",
      });
    });

    it("returns 404 if the column is not on the board", async () => {
      boardWorld();
      mockSession();

      const res = await app.request(
        `${baseUrl}/${boardId}/columns/no-such-column`,
        json("PUT", { name: "Updated Column" }),
      );

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Column not found" });
    });

    it("returns 409 if renaming to an existing column name", async () => {
      boardWorld();
      mockSession();

      const res = await app.request(
        `${baseUrl}/${boardId}/columns/col-1`,
        json("PUT", { name: "Done" }),
      );

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "A column with this name already exists on the board",
      });
    });
  });

  describe("DELETE /:boardId/columns/:columnId", () => {
    it("deletes the column", async () => {
      boardWorld();
      mockSession();

      const res = await app.request(`${baseUrl}/${boardId}/columns/col-1`, {
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Column deleted" });
    });

    it("returns 404 if the column is not on the board", async () => {
      boardWorld();
      mockSession();

      const res = await app.request(
        `${baseUrl}/${boardId}/columns/no-such-column`,
        { method: "DELETE" },
      );

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Column not found" });
    });
  });

  /**
   * These state fixture rows rather than counting queries: `seedDb()`
   * interprets the `WHERE` each query builds, so a Column write that trusts the
   * `boardId` in the URL reaches the other Workspace's row and the test fails.
   * The caller owns `ws-1`; `board-b` and its Column live in `ws-2`, which
   * belongs to someone else in the same Organization.
   */
  describe("column writes are scoped to the Workspace", () => {
    const world = (): FakeDb =>
      seedDb({
        organization_member: [
          { id: "m1", userId: "user-1", organizationId: orgId, role: "member" },
        ],
        workspace: [
          { id: workspaceId, organizationId: orgId, ownerId: "user-1" },
          { id: "ws-2", organizationId: orgId, ownerId: "other-user" },
        ],
        kanban_board: [
          { id: boardId, workspaceId, name: "Mine", labels: [] },
          { id: "board-b", workspaceId: "ws-2", name: "Theirs", labels: [] },
        ],
        kanban_column: [
          { id: "col-1", boardId, name: "To Do", position: 1 },
          { id: "col-b", boardId: "board-b", name: "To Do", position: 1 },
        ],
      });

    it("does not rename a Column on another Workspace's Board", async () => {
      const fake = world();
      mockSession();

      const res = await app.request(`${baseUrl}/board-b/columns/col-b`, {
        method: "PUT",
        body: JSON.stringify({ name: "Hijacked" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(404);
      expect(fake.tables.kanban_column).toContainEqual(
        expect.objectContaining({ id: "col-b", name: "To Do" }),
      );
    });

    it("does not delete a Column on another Workspace's Board", async () => {
      const fake = world();
      mockSession();

      const res = await app.request(`${baseUrl}/board-b/columns/col-b`, {
        method: "DELETE",
      });

      expect(res.status).toBe(404);
      expect(fake.tables.kanban_column).toContainEqual(
        expect.objectContaining({ id: "col-b" }),
      );
    });

    it("deletes a Column on a Board in this Workspace", async () => {
      const fake = world();
      mockSession();

      const res = await app.request(`${baseUrl}/${boardId}/columns/col-1`, {
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      expect(fake.tables.kanban_column.map((col) => col.id)).toEqual(["col-b"]);
    });
  });

  describe("PUT /:boardId/columns/reorder", () => {
    it("returns 404 for another Workspace's board", async () => {
      boardWorld();
      mockSession();

      const res = await app.request(
        `${baseUrl}/board-b/columns/reorder`,
        json("PUT", { columnIds: ["col-b"] }),
      );

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Board not found" });
    });

    it("reorders the columns", async () => {
      const fake = boardWorld();
      mockSession();

      const res = await app.request(
        `${baseUrl}/${boardId}/columns/reorder`,
        json("PUT", { columnIds: ["col-2", "col-1"] }),
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Columns reordered" });
      expect(
        fake.tables.kanban_column
          .filter((col) => col.boardId === boardId)
          .map((col) => [col.id, col.position]),
      ).toEqual([
        ["col-1", 2],
        ["col-2", 1],
      ]);
    });

    // The frontend's write helper reads `error`, so the reason reaches the user.
    it("returns 400 with an error when a column is not on the board", async () => {
      boardWorld();
      mockSession();

      const res = await app.request(
        `${baseUrl}/${boardId}/columns/reorder`,
        json("PUT", { columnIds: ["col-1", "col-b"] }),
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Some column IDs do not belong to this board",
      });
    });
  });

  describe("POST /:boardId/columns/:columnId/cards", () => {
    it("should create card", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([{ id: "col-1", boardId: "board-1" }]); // column guard
      mockDb.limit.mockResolvedValueOnce([{ id: "col-1", name: "To do" }]); // the created entry snapshots its column name
      mockDb.limit.mockResolvedValueOnce([]); // the history trim's subquery

      const mockCard = {
        id: "test-id-123",
        columnId: "col-1",
        title: "New Card",
        position: 2.0,
      };
      mockDb.returning.mockResolvedValueOnce([mockCard]);

      const res = await app.request(
        `${baseUrl}/${boardId}/columns/col-1/cards`,
        {
          method: "POST",
          body: JSON.stringify({ title: "New Card" }),
          headers: { "Content-Type": "application/json" },
        },
      );

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual(mockCard);
    });
  });

  describe("PUT /:boardId/cards/:cardId - board membership", () => {
    it("should return 404 when card does not belong to board", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([]); // card guard — not on this board

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
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([
        { id: "card-1", columnId: "col-1", boardId: "board-1" },
      ]); // card guard
      mockDb.limit.mockResolvedValueOnce([
        { id: "card-1", columnId: "col-1", title: "Card" },
      ]); // prior row, for the changedFields value-diff

      // Carries its column: a row that omitted it would read as a column
      // change to the value-diff behind the history entry.
      const mockCard = {
        id: "card-1",
        columnId: "col-1",
        title: "Updated Card",
      };
      mockDb.returning.mockResolvedValueOnce([mockCard]);
      mockDb.limit.mockResolvedValueOnce([]); // the history trim's subquery

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
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([]); // card guard — not found

      const res = await app.request(`${baseUrl}/${boardId}/cards/card-1`, {
        method: "PUT",
        body: JSON.stringify({ title: "Updated Card" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(404);
    });

    describe("Label validation", () => {
      const mockBoardLabels = (labels: { id: string }[]) => {
        mockDb.limit.mockResolvedValueOnce([{ labels }]); // board labels lookup
      };

      it("should persist valid label IDs unchanged", async () => {
        mockSession();
        mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
        mockDb.limit.mockResolvedValueOnce([
          { ownerId: "user-1", organizationId: "org-1" },
        ]); // requireWorkspaceAccess
        mockDb.limit.mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", boardId: "board-1" },
        ]); // card guard
        mockDb.limit.mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", labelIds: [] },
        ]); // prior row, for the changedFields value-diff
        mockBoardLabels([{ id: "lbl-a" }, { id: "lbl-b" }]);
        // Carries the column it stays in and the labels it persisted, so the
        // value-diff behind the history entry sees only the label change.
        mockDb.returning.mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", labelIds: ["lbl-b", "lbl-a"] },
        ]);
        mockDb.limit.mockResolvedValueOnce([
          {
            labels: [
              { id: "lbl-a", name: "A" },
              { id: "lbl-b", name: "B" },
            ],
          },
        ]); // board labels again, for the entry's name snapshot
        mockDb.limit.mockResolvedValueOnce([]); // the history trim's subquery

        const res = await app.request(`${baseUrl}/${boardId}/cards/card-1`, {
          method: "PUT",
          body: JSON.stringify({ labelIds: ["lbl-b", "lbl-a"] }),
          headers: { "Content-Type": "application/json" },
        });

        expect(res.status).toBe(200);
        expect(mockDb.set).toHaveBeenCalledWith(
          expect.objectContaining({ labelIds: ["lbl-b", "lbl-a"] }),
        );
      });

      it("should drop unknown label IDs and apply the rest of the update", async () => {
        mockSession();
        mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
        mockDb.limit.mockResolvedValueOnce([
          { ownerId: "user-1", organizationId: "org-1" },
        ]); // requireWorkspaceAccess
        mockDb.limit.mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", boardId: "board-1" },
        ]); // card guard
        mockDb.limit.mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", labelIds: [] },
        ]); // prior row, for the changedFields value-diff
        mockBoardLabels([{ id: "lbl-new" }]);
        // Carries the column it stays in and the labels it persisted, so the
        // value-diff behind the history entry sees only the label change.
        mockDb.returning.mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", labelIds: ["lbl-new"] },
        ]);
        mockDb.limit.mockResolvedValueOnce([
          { labels: [{ id: "lbl-new", name: "New" }] },
        ]); // board labels again, for the entry's name snapshot
        mockDb.limit.mockResolvedValueOnce([]); // the history trim's subquery

        const res = await app.request(`${baseUrl}/${boardId}/cards/card-1`, {
          method: "PUT",
          body: JSON.stringify({
            title: "Retitled",
            priority: "high",
            labelIds: ["lbl-deleted", "lbl-new"],
          }),
          headers: { "Content-Type": "application/json" },
        });

        expect(res.status).toBe(200);
        expect(mockDb.set).toHaveBeenCalledWith(
          expect.objectContaining({
            title: "Retitled",
            priority: "high",
            labelIds: ["lbl-new"],
          }),
        );
      });

      it("should end with an empty label list when every submitted ID is unknown", async () => {
        mockSession();
        mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
        mockDb.limit.mockResolvedValueOnce([
          { ownerId: "user-1", organizationId: "org-1" },
        ]); // requireWorkspaceAccess
        mockDb.limit.mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", boardId: "board-1" },
        ]); // card guard
        mockDb.limit.mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", labelIds: [] },
        ]); // prior row, for the changedFields value-diff
        mockBoardLabels([]);
        // Every submitted label was unknown, so the card ends where it started
        // and the write changes nothing a history entry would record.
        mockDb.returning.mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", labelIds: [] },
        ]);
        mockDb.limit.mockResolvedValueOnce([]); // the history trim's subquery

        const res = await app.request(`${baseUrl}/${boardId}/cards/card-1`, {
          method: "PUT",
          body: JSON.stringify({ labelIds: ["lbl-deleted"] }),
          headers: { "Content-Type": "application/json" },
        });

        expect(res.status).toBe(200);
        expect(mockDb.set).toHaveBeenCalledWith(
          expect.objectContaining({ labelIds: [] }),
        );
      });
    });

    describe("Assignee validation", () => {
      it("should return 400 for invalid user assignee", async () => {
        mockSession();
        mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
        mockDb.limit.mockResolvedValueOnce([
          { ownerId: "user-1", organizationId: "org-1" },
        ]); // requireWorkspaceAccess
        mockDb.limit.mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", boardId: "board-1" },
        ]); // card guard
        mockDb.limit.mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1" },
        ]); // prior row, for the changedFields value-diff
        // assignee validation: org member query then super admin query
        mockDb.where.mockReturnValueOnce(mockDb); // requireOrgAccess chain
        mockDb.where.mockReturnValueOnce(mockDb); // requireWorkspaceAccess chain
        mockDb.where.mockReturnValueOnce(mockDb); // card guard chain
        mockDb.where.mockReturnValueOnce(mockDb); // currentCardRow chain
        mockDb.where.mockResolvedValueOnce([]); // org member lookup — not found
        mockDb.where.mockResolvedValueOnce([]); // super admin lookup — not found

        const res = await app.request(`${baseUrl}/${boardId}/cards/card-1`, {
          method: "PUT",
          body: JSON.stringify({
            assignees: [{ type: "user", id: "nonexistent" }],
          }),
          headers: { "Content-Type": "application/json" },
        });

        expect(res.status).toBe(400);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.error).toBe("Invalid user assignee");
      });

      it("should allow super admin to be assigned", async () => {
        mockSession({
          id: "admin-user",
          email: "admin@example.com",
          role: "admin",
        });
        // Super admin bypasses requireOrgAccess (no DB query)
        mockDb.limit.mockResolvedValueOnce([
          { ownerId: "admin-user", organizationId: "org-1" },
        ]); // requireWorkspaceAccess
        mockDb.limit.mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", boardId: "board-1" },
        ]); // card guard
        mockDb.limit.mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1" },
        ]); // prior row, for the changedFields value-diff
        // assignee validation queries
        mockDb.where.mockReturnValueOnce(mockDb); // requireWorkspaceAccess chain
        mockDb.where.mockReturnValueOnce(mockDb); // card guard chain
        mockDb.where.mockReturnValueOnce(mockDb); // currentCardRow chain
        mockDb.where.mockResolvedValueOnce([]); // org member lookup — not found
        mockDb.where.mockResolvedValueOnce([{ id: "admin-user" }]); // super admin lookup — found
        mockDb.where.mockReturnValueOnce(mockDb); // card update chain

        const mockCard = {
          id: "card-1",
          columnId: "col-1",
          title: "Test",
          assignees: [{ type: "user", id: "admin-user" }],
        };
        mockDb.returning.mockResolvedValueOnce([mockCard]);

        const res = await app.request(`${baseUrl}/${boardId}/cards/card-1`, {
          method: "PUT",
          body: JSON.stringify({
            assignees: [{ type: "user", id: "admin-user" }],
          }),
          headers: { "Content-Type": "application/json" },
        });

        expect(res.status).toBe(200);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.assignees).toEqual([{ type: "user", id: "admin-user" }]);
      });

      it("should allow a shared agent attached to this workspace to be assigned", async () => {
        // The assignee picker offers every Agent visible in the Workspace, which
        // includes attached Shared Agents — and one can run here, so it can own
        // a card (ADR-0007).
        mockSession();
        mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
        mockDb.limit.mockResolvedValueOnce([
          { ownerId: "user-1", organizationId: "org-1" },
        ]); // requireWorkspaceAccess
        mockDb.limit.mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", boardId: "board-1" },
        ]); // card guard
        mockDb.limit.mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1" },
        ]); // prior row, for the changedFields value-diff
        mockDb.where.mockReturnValueOnce(mockDb); // requireOrgAccess chain
        mockDb.where.mockReturnValueOnce(mockDb); // requireWorkspaceAccess chain
        mockDb.where.mockReturnValueOnce(mockDb); // card guard chain
        mockDb.where.mockReturnValueOnce(mockDb); // currentCardRow chain
        // No user assignees, so the visibility lookup's two queries come first:
        // workspace-scoped agents, then org-scoped ones joined to an attachment.
        mockDb.where.mockResolvedValueOnce([]);
        mockDb.where.mockResolvedValueOnce([
          {
            agent: {
              id: "shared-agent",
              organizationId: "org-1",
              workspaceId: null,
            },
            attachment: { id: "att-1" },
          },
        ]);
        mockDb.where.mockReturnValueOnce(mockDb); // card update chain

        const mockCard = {
          id: "card-1",
          columnId: "col-1",
          title: "Test",
          assignees: [{ type: "agent", id: "shared-agent" }],
        };
        mockDb.returning.mockResolvedValueOnce([mockCard]);

        const res = await app.request(`${baseUrl}/${boardId}/cards/card-1`, {
          method: "PUT",
          body: JSON.stringify({
            assignees: [{ type: "agent", id: "shared-agent" }],
          }),
          headers: { "Content-Type": "application/json" },
        });

        expect(res.status).toBe(200);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.assignees).toEqual([{ type: "agent", id: "shared-agent" }]);
      });

      it("should return 400 for an agent that is not visible in this workspace", async () => {
        mockSession();
        mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
        mockDb.limit.mockResolvedValueOnce([
          { ownerId: "user-1", organizationId: "org-1" },
        ]); // requireWorkspaceAccess
        mockDb.limit.mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", boardId: "board-1" },
        ]); // card guard
        mockDb.limit.mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1" },
        ]); // prior row, for the changedFields value-diff
        mockDb.where.mockReturnValueOnce(mockDb); // requireOrgAccess chain
        mockDb.where.mockReturnValueOnce(mockDb); // requireWorkspaceAccess chain
        mockDb.where.mockReturnValueOnce(mockDb); // card guard chain
        mockDb.where.mockReturnValueOnce(mockDb); // currentCardRow chain
        mockDb.where.mockResolvedValueOnce([]); // no workspace-scoped match
        mockDb.where.mockResolvedValueOnce([]); // no attached org-scoped match

        const res = await app.request(`${baseUrl}/${boardId}/cards/card-1`, {
          method: "PUT",
          body: JSON.stringify({
            assignees: [{ type: "agent", id: "someone-elses-agent" }],
          }),
          headers: { "Content-Type": "application/json" },
        });

        expect(res.status).toBe(400);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.error).toBe("Invalid agent assignee");
        // Both scopes were consulted: after the card guard's two joins
        // (card → column → board) comes the Attachment join that a
        // workspace-only lookup never makes.
        expect(mockDb.innerJoin).toHaveBeenCalledTimes(3);
      });

      it("should allow org member to be assigned", async () => {
        mockSession();
        mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
        mockDb.limit.mockResolvedValueOnce([
          { ownerId: "user-1", organizationId: "org-1" },
        ]); // requireWorkspaceAccess
        mockDb.limit.mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", boardId: "board-1" },
        ]); // card guard
        mockDb.limit.mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1" },
        ]); // prior row, for the changedFields value-diff
        // assignee validation queries
        mockDb.where.mockReturnValueOnce(mockDb); // requireOrgAccess chain
        mockDb.where.mockReturnValueOnce(mockDb); // requireWorkspaceAccess chain
        mockDb.where.mockReturnValueOnce(mockDb); // card guard chain
        mockDb.where.mockReturnValueOnce(mockDb); // currentCardRow chain
        mockDb.where.mockResolvedValueOnce([{ userId: "user-1" }]); // org member lookup — found
        mockDb.where.mockResolvedValueOnce([]); // super admin lookup — not found
        mockDb.where.mockReturnValueOnce(mockDb); // card update chain

        const mockCard = {
          id: "card-1",
          columnId: "col-1",
          title: "Test",
          assignees: [{ type: "user", id: "user-1" }],
        };
        mockDb.returning.mockResolvedValueOnce([mockCard]);

        const res = await app.request(`${baseUrl}/${boardId}/cards/card-1`, {
          method: "PUT",
          body: JSON.stringify({
            assignees: [{ type: "user", id: "user-1" }],
          }),
          headers: { "Content-Type": "application/json" },
        });

        expect(res.status).toBe(200);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.assignees).toEqual([{ type: "user", id: "user-1" }]);
      });
    });
  });

  describe("POST /:boardId/cards/:cardId/move", () => {
    it("should move card to beginning of column", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess

      mockDb.limit.mockResolvedValueOnce([
        { id: "card-1", columnId: "col-1", boardId: "board-1" },
      ]); // card guard
      mockDb.limit.mockResolvedValueOnce([{ id: "col-2", boardId: "board-1" }]); // target column guard
      mockDb.limit.mockResolvedValueOnce([
        { id: "col-1", name: "To do" },
        { id: "col-2", name: "Doing" },
      ]); // the move's history entry snapshots both column names
      mockDb.limit.mockResolvedValueOnce([]); // the history trim's subquery

      const existingCards = [
        { id: "card-2", columnId: "col-2", position: 1.0 },
        { id: "card-3", columnId: "col-2", position: 2.0 },
      ];
      mockDb.orderBy.mockResolvedValueOnce(existingCards);

      const updatedCard = { id: "card-1", columnId: "col-2", position: 0.5 };
      mockDb.returning.mockResolvedValueOnce([updatedCard]);

      const res = await app.request(`${baseUrl}/${boardId}/cards/card-1/move`, {
        method: "POST",
        body: JSON.stringify({ columnId: "col-2", afterCardId: null }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
    });

    // ADR-0010: a stale view of the board is a conflict, not a malformed
    // request, so the UI can tell "re-sync" apart from "you sent nonsense".
    it("should answer 409 when the card has left the expected column", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess

      mockDb.limit.mockResolvedValueOnce([
        { id: "card-1", columnId: "col-2", boardId: "board-1" },
      ]); // card guard — already moved on
      mockDb.limit.mockResolvedValueOnce([{ id: "col-2", boardId: "board-1" }]); // target column guard
      mockDb.limit.mockResolvedValueOnce([
        { id: "col-1", name: "To do" },
        { id: "col-2", name: "Doing" },
      ]); // the move's history entry snapshots both column names
      mockDb.limit.mockResolvedValueOnce([]); // the history trim's subquery

      mockDb.orderBy.mockResolvedValueOnce([]);
      mockDb.returning.mockResolvedValueOnce([]); // the predicate matched no row

      const res = await app.request(`${baseUrl}/${boardId}/cards/card-1/move`, {
        method: "POST",
        body: JSON.stringify({
          columnId: "col-2",
          afterCardId: null,
          expectedColumnId: "col-1",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(409);
    });

    it("should move card after another card", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess

      mockDb.limit.mockResolvedValueOnce([
        { id: "card-1", columnId: "col-1", boardId: "board-1" },
      ]); // card guard
      mockDb.limit.mockResolvedValueOnce([{ id: "col-2", boardId: "board-1" }]); // target column guard
      mockDb.limit.mockResolvedValueOnce([
        { id: "col-1", name: "To do" },
        { id: "col-2", name: "Doing" },
      ]); // the move's history entry snapshots both column names
      mockDb.limit.mockResolvedValueOnce([]); // the history trim's subquery

      const existingCards = [
        { id: "card-2", columnId: "col-2", position: 1.0 },
        { id: "card-3", columnId: "col-2", position: 2.0 },
      ];
      mockDb.orderBy.mockResolvedValueOnce(existingCards);

      const updatedCard = { id: "card-1", columnId: "col-2", position: 1.5 };
      mockDb.returning.mockResolvedValueOnce([updatedCard]);

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
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess

      mockDb.limit.mockResolvedValueOnce([
        { id: "card-1", columnId: "col-1", boardId: "board-1" },
      ]); // card guard
      mockDb.limit.mockResolvedValueOnce([{ id: "col-1", boardId: "board-1" }]); // target column guard

      // Cards with very small gap between positions 1 and 2
      const existingCards = [
        { id: "card-2", columnId: "col-1", position: 1.0 },
        { id: "card-3", columnId: "col-1", position: 1.0000001 }, // gap < 0.001
      ];
      mockDb.orderBy.mockResolvedValueOnce(existingCards);

      const updatedCard = { id: "card-1", columnId: "col-1", position: 2.0 };
      mockDb.returning.mockResolvedValueOnce([updatedCard]);

      const res = await app.request(`${baseUrl}/${boardId}/cards/card-1/move`, {
        method: "POST",
        body: JSON.stringify({ columnId: "col-1", afterCardId: "card-2" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      expect(mockDb.transaction).toHaveBeenCalled();
    });

    it("should return 400 if afterCardId not found in column", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess

      mockDb.limit.mockResolvedValueOnce([
        { id: "card-1", columnId: "col-1", boardId: "board-1" },
      ]); // card guard
      mockDb.limit.mockResolvedValueOnce([{ id: "col-2", boardId: "board-1" }]); // target column guard
      mockDb.limit.mockResolvedValueOnce([
        { id: "col-1", name: "To do" },
        { id: "col-2", name: "Doing" },
      ]); // the move's history entry snapshots both column names
      mockDb.limit.mockResolvedValueOnce([]); // the history trim's subquery

      const existingCards = [
        { id: "card-2", columnId: "col-2", position: 1.0 },
      ];
      mockDb.orderBy.mockResolvedValueOnce(existingCards);

      const res = await app.request(`${baseUrl}/${boardId}/cards/card-1/move`, {
        method: "POST",
        body: JSON.stringify({
          columnId: "col-2",
          afterCardId: "non-existent",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("afterCardId not found in column");
    });
  });

  describe("DELETE /:boardId/cards/:cardId - board membership", () => {
    it("should return 404 when card does not belong to board", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([]); // card guard — not on this board

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
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([
        { id: "card-1", columnId: "col-1", boardId: "board-1" },
      ]); // card guard

      const res = await app.request(`${baseUrl}/${boardId}/cards/card-1`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Card deleted" });
    });

    it("should return 404 if card not found", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([]); // card guard — not found

      const res = await app.request(`${baseUrl}/${boardId}/cards/card-1`, {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /:boardId/cards/:cardId/history", () => {
    const historyWorld = () => {
      const fake = boardWorld({
        cards: [
          { id: "card-1", columnId: "col-1" },
          { id: "card-b", columnId: "col-b" },
        ],
      });
      const at = (day: number) => new Date(`2026-01-0${day}T00:00:00.000Z`);
      fake.tables.kanban_card_history = [
        { id: "h1", cardId: "card-1", actorUserId: "user-1", createdAt: at(1) },
        { id: "h2", cardId: "card-1", actorUserId: null, createdAt: at(3) },
        { id: "h3", cardId: "card-1", actorUserId: "gone", createdAt: at(2) },
        { id: "hb", cardId: "card-b", actorUserId: null, createdAt: at(4) },
      ];
      return fake;
    };

    it("lists the card's history newest first, with actor names", async () => {
      historyWorld();
      mockSession();

      const res = await app.request(
        `${baseUrl}/${boardId}/cards/card-1/history`,
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: { id: string; actorName: string | null }[];
      };
      // A deleted actor keeps its entry, nameless.
      expect(body.results.map((h) => [h.id, h.actorName])).toEqual([
        ["h2", null],
        ["h3", null],
        ["h1", "Ada"],
      ]);
    });

    it("returns 404 for a card on another Workspace's board", async () => {
      historyWorld();
      mockSession();

      const res = await app.request(`${baseUrl}/board-b/cards/card-b/history`);
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
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([]); // card verification → not found

      const res = await app.request(commentsUrl);
      expect(res.status).toBe(404);
    });

    it("should return comments for card with createdByName resolved", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([{ id: cardId }]); // card verification → found
      mockDb.orderBy.mockResolvedValueOnce([mockComment]); // comments query

      const res = await app.request(commentsUrl);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: { body: string; createdByName: string | null }[];
      };
      expect(body.results).toHaveLength(1);
      expect(body.results[0].body).toBe("Test comment");
      expect(body.results[0].createdByName).toBeNull();
    });

    it("should return empty results when card has no comments", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([{ id: cardId }]); // card found
      mockDb.orderBy.mockResolvedValueOnce([]); // no comments

      const res = await app.request(commentsUrl);
      expect(res.status).toBe(200);
      expect(
        ((await res.json()) as { results: unknown[] }).results,
      ).toHaveLength(0);
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
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
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
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([{ id: cardId }]); // card found
      mockDb.returning.mockResolvedValueOnce([mockComment]); // insert

      const res = await app.request(commentsUrl, {
        method: "POST",
        body: JSON.stringify({ body: "Test comment" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.body).toBe("Test comment");
      expect(body.id).toBe(commentId);
    });

    it("should return 400 if body is empty string", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess

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
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess

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
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([
        { ...mockComment, createdByUserId: "user-1" },
      ]); // ownership check

      const updatedComment = { ...mockComment, body: "Updated" };
      mockDb.returning.mockResolvedValueOnce([updatedComment]); // update

      const res = await app.request(`${commentsUrl}/${commentId}`, {
        method: "PUT",
        body: JSON.stringify({ body: "Updated" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { body: string }).body).toBe("Updated");
    });

    it("should return 404 if comment not found", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([]); // ownership check - not found

      const res = await app.request(`${commentsUrl}/${commentId}`, {
        method: "PUT",
        body: JSON.stringify({ body: "Updated" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(404);
    });

    it("returns 404 for a comment that belongs to a different card", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([
        { ...mockComment, cardId: "card-2", createdByUserId: "user-1" },
      ]); // comment lookup — on the same board, but another card

      const res = await app.request(`${commentsUrl}/${commentId}`, {
        method: "PUT",
        body: JSON.stringify({ body: "Updated" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(404);
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("should return 403 if user does not own comment", async () => {
      mockSession({
        id: "other-user",
        email: "other@example.com",
        role: "user",
      });
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "other-user", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([
        { ...mockComment, createdByUserId: "user-1" },
      ]); // ownership check - owned by different user

      const res = await app.request(`${commentsUrl}/${commentId}`, {
        method: "PUT",
        body: JSON.stringify({ body: "Updated" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe(
        "You can only edit your own comments",
      );
    });

    it("should allow org admin to edit another user's comment", async () => {
      mockSession({
        id: "admin-user",
        email: "admin@example.com",
        role: "user",
      });
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess - org admin
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "admin-user", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([
        { ...mockComment, createdByUserId: "user-1" },
      ]); // ownership check - owned by different user

      const updatedComment = { ...mockComment, body: "Admin edit" };
      mockDb.returning.mockResolvedValueOnce([updatedComment]); // update

      const res = await app.request(`${commentsUrl}/${commentId}`, {
        method: "PUT",
        body: JSON.stringify({ body: "Admin edit" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(200);
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
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([
        { ...mockComment, createdByUserId: "user-1" },
      ]); // ownership check

      const res = await app.request(`${commentsUrl}/${commentId}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
    });

    it("should return 404 if comment not found", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([]); // ownership check - not found

      const res = await app.request(`${commentsUrl}/${commentId}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });

    it("should return 403 if user does not own comment", async () => {
      mockSession({
        id: "other-user",
        email: "other@example.com",
        role: "user",
      });
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "other-user", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([
        { ...mockComment, createdByUserId: "user-1" },
      ]); // ownership check

      const res = await app.request(`${commentsUrl}/${commentId}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe(
        "You can only delete your own comments",
      );
    });

    it("should allow org admin to delete another user's comment", async () => {
      mockSession({
        id: "admin-user",
        email: "admin@example.com",
        role: "user",
      });
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess - org admin
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "admin-user", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([
        { ...mockComment, createdByUserId: "user-1" },
      ]); // ownership check

      const res = await app.request(`${commentsUrl}/${commentId}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
    });
  });
});
