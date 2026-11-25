import { describe, it, expect, beforeEach, vi } from "vitest";
import { nanoid } from "nanoid";
import {
  mockSession,
  mockNoSession,
  resetMockDb,
  seedDb,
  type FakeDb,
  type Row,
  type Store,
} from "../test-utils.ts";
import app from "../server.ts";

vi.mock("nanoid", { spy: true });

describe("Kanban Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  const orgId = "org-1";
  const workspaceId = "ws-1";
  const boardId = "board-1";
  const baseUrl = `/organizations/${orgId}/workspaces/${workspaceId}/boards`;

  const boardWorld = (
    over: {
      owner?: string;
      cards?: Row[];
      labels?: Row[];
      members?: Row[];
      users?: Row[];
      tables?: Store;
    } = {},
  ): FakeDb =>
    seedDb({
      organization_member: over.members ?? [
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
          labels: over.labels ?? [
            { id: "label-1", name: "Bug", color: "#ef4444" },
          ],
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
      user: over.users ?? [{ id: "user-1", name: "Ada", image: null }],
      ...over.tables,
    });

  const cardRow = (over: Row = {}): Row => ({
    id: "card-1",
    columnId: "col-1",
    title: "Card",
    body: null,
    labelIds: [],
    assignees: [],
    priority: "none",
    position: 1,
    ...over,
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
      vi.mocked(nanoid).mockReturnValueOnce("board-new");
      const fake = boardWorld();
      mockSession();

      const res = await app.request(
        baseUrl,
        json("POST", { name: "New Board" }),
      );

      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({
        id: "board-new",
        name: "New Board",
        workspaceId,
      });
      expect(
        fake.tables.kanban_column
          .filter((col) => col.boardId === "board-new")
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
        json("PUT", {
          name: "Updated Board",
          description: null,
          labels: [],
        }),
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        id: boardId,
        name: "Updated Board",
      });
    });

    it.each(["name", "description", "labels"])(
      "returns 400 when %s is omitted",
      async (key) => {
        boardWorld();
        mockSession();

        const body: Record<string, unknown> = {
          name: "Updated Board",
          description: null,
          labels: [],
        };
        delete body[key];

        const res = await app.request(
          `${baseUrl}/${boardId}`,
          json("PUT", body),
        );

        expect(res.status).toBe(400);
      },
    );

    it("returns 404 for another Workspace's board", async () => {
      const fake = boardWorld();
      mockSession();

      const res = await app.request(
        `${baseUrl}/board-b`,
        json("PUT", { name: "Hijacked", description: null, labels: [] }),
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
      vi.mocked(nanoid).mockReturnValueOnce("col-new");
      boardWorld();
      mockSession();

      const res = await app.request(
        `${baseUrl}/${boardId}/columns`,
        json("POST", { name: "New Column" }),
      );

      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({
        id: "col-new",
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
      vi.mocked(nanoid).mockReturnValueOnce("test-id-123");
      const fake = boardWorld({
        cards: [
          {
            id: "card-existing",
            columnId: "col-1",
            title: "Existing",
            labelIds: [],
            assignees: [],
            priority: "none",
            position: 1,
          },
        ],
      });

      const mockCard = {
        id: "test-id-123",
        columnId: "col-1",
        title: "New Card",
        position: 2.0,
      };

      const res = await app.request(
        `${baseUrl}/${boardId}/columns/col-1/cards`,
        {
          method: "POST",
          body: JSON.stringify({ title: "New Card" }),
          headers: { "Content-Type": "application/json" },
        },
      );

      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject(mockCard);
      expect(fake.tables.kanban_card).toContainEqual(
        expect.objectContaining(mockCard),
      );
    });
  });

  describe("PATCH /:boardId/cards/:cardId - board membership", () => {
    it("should return 404 when card does not belong to board", async () => {
      // why: a second board in the same workspace, so only the board check can answer 404
      const fake = boardWorld({
        cards: [cardRow({ id: "card-2", columnId: "col-sibling" })],
        tables: {
          kanban_board: [
            {
              id: boardId,
              workspaceId,
              name: "Mine",
              description: null,
              labels: [],
              createdAt: new Date("2026-01-01T00:00:00.000Z"),
              updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            },
            {
              id: "board-sibling",
              workspaceId,
              name: "Sibling",
              description: null,
              labels: [],
              createdAt: new Date("2026-01-02T00:00:00.000Z"),
              updatedAt: new Date("2026-01-02T00:00:00.000Z"),
            },
          ],
          kanban_column: [
            { id: "col-1", boardId, name: "To Do", position: 1 },
            {
              id: "col-sibling",
              boardId: "board-sibling",
              name: "To Do",
              position: 1,
            },
          ],
        },
      });
      mockSession();

      const res = await app.request(
        `${baseUrl}/${boardId}/cards/card-2`,
        json("PATCH", { title: "Hack" }),
      );

      expect(res.status).toBe(404);
      expect(fake.tables.kanban_card[0]).toMatchObject({
        id: "card-2",
        title: "Card",
      });
    });
  });

  describe("PATCH /:boardId/cards/:cardId", () => {
    it("keeps the labels, assignees and priority an update does not mention", async () => {
      const fake = boardWorld({
        cards: [
          {
            id: "card-1",
            columnId: "col-1",
            title: "Card",
            body: null,
            labelIds: ["label-1"],
            assignees: [{ type: "user", id: "user-1" }],
            dueDate: null,
            priority: "high",
            position: 1,
            commentCount: 0,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          },
        ],
      });
      mockSession();

      const res = await app.request(
        `${baseUrl}/${boardId}/cards/card-1`,
        json("PATCH", { title: "Renamed" }),
      );

      expect(res.status).toBe(200);
      expect(fake.tables.kanban_card[0]).toMatchObject({
        title: "Renamed",
        labelIds: ["label-1"],
        assignees: [{ type: "user", id: "user-1" }],
        priority: "high",
      });
    });

    it("should update card", async () => {
      mockSession();
      const fake = boardWorld({
        cards: [
          {
            id: "card-1",
            columnId: "col-1",
            title: "Card",
            body: null,
            labelIds: [],
            assignees: [],
            priority: "none",
            position: 1,
          },
        ],
      });

      const mockCard = {
        id: "card-1",
        columnId: "col-1",
        title: "Updated Card",
      };

      const res = await app.request(`${baseUrl}/${boardId}/cards/card-1`, {
        method: "PATCH",
        body: JSON.stringify({ title: "Updated Card" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject(mockCard);
      expect(fake.tables.kanban_card[0]).toMatchObject(mockCard);
    });

    it("should return 404 if card not found", async () => {
      mockSession();
      boardWorld();

      const res = await app.request(`${baseUrl}/${boardId}/cards/card-1`, {
        method: "PATCH",
        body: JSON.stringify({ title: "Updated Card" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(404);
    });

    describe("Label validation", () => {
      it("should persist valid label IDs unchanged", async () => {
        mockSession();
        const fake = boardWorld({
          cards: [cardRow()],
          labels: [
            { id: "lbl-a", name: "A" },
            { id: "lbl-b", name: "B" },
          ],
        });

        const res = await app.request(`${baseUrl}/${boardId}/cards/card-1`, {
          method: "PATCH",
          body: JSON.stringify({ labelIds: ["lbl-b", "lbl-a"] }),
          headers: { "Content-Type": "application/json" },
        });

        expect(res.status).toBe(200);
        expect(fake.tables.kanban_card[0]).toMatchObject({
          labelIds: ["lbl-b", "lbl-a"],
        });
      });

      it("should drop unknown label IDs and apply the rest of the update", async () => {
        mockSession();
        const fake = boardWorld({
          cards: [cardRow()],
          labels: [{ id: "lbl-new", name: "New" }],
        });

        const res = await app.request(`${baseUrl}/${boardId}/cards/card-1`, {
          method: "PATCH",
          body: JSON.stringify({
            title: "Retitled",
            priority: "high",
            labelIds: ["lbl-deleted", "lbl-new"],
          }),
          headers: { "Content-Type": "application/json" },
        });

        expect(res.status).toBe(200);
        expect(fake.tables.kanban_card[0]).toMatchObject({
          title: "Retitled",
          priority: "high",
          labelIds: ["lbl-new"],
        });
      });

      it("should end with an empty label list when every submitted ID is unknown", async () => {
        mockSession();
        const fake = boardWorld({
          cards: [cardRow()],
          labels: [],
        });

        const res = await app.request(`${baseUrl}/${boardId}/cards/card-1`, {
          method: "PATCH",
          body: JSON.stringify({ labelIds: ["lbl-deleted"] }),
          headers: { "Content-Type": "application/json" },
        });

        expect(res.status).toBe(200);
        expect(fake.tables.kanban_card[0]).toMatchObject({ labelIds: [] });
      });
    });

    describe("Assignee validation", () => {
      it("should return 400 for invalid user assignee", async () => {
        mockSession();
        boardWorld({ cards: [cardRow()] });

        const res = await app.request(`${baseUrl}/${boardId}/cards/card-1`, {
          method: "PATCH",
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
        const fake = boardWorld({
          owner: "admin-user",
          members: [],
          cards: [cardRow()],
          users: [
            { id: "admin-user", name: "Admin", image: null, role: "admin" },
          ],
        });

        const res = await app.request(`${baseUrl}/${boardId}/cards/card-1`, {
          method: "PATCH",
          body: JSON.stringify({
            assignees: [{ type: "user", id: "admin-user" }],
          }),
          headers: { "Content-Type": "application/json" },
        });

        expect(res.status).toBe(200);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.assignees).toEqual([{ type: "user", id: "admin-user" }]);
        expect(fake.tables.kanban_card[0]).toMatchObject({
          assignees: [{ type: "user", id: "admin-user" }],
        });
      });

      it("should allow a shared agent attached to this workspace to be assigned", async () => {
        mockSession();
        const fake = boardWorld({
          cards: [cardRow()],
          tables: {
            agent: [
              {
                id: "shared-agent",
                organizationId: orgId,
                workspaceId: null,
                name: "Shared Agent",
              },
            ],
            attachment: [
              {
                id: "att-1",
                workspaceId,
                resourceType: "agent",
                resourceId: "shared-agent",
              },
            ],
          },
        });

        const res = await app.request(`${baseUrl}/${boardId}/cards/card-1`, {
          method: "PATCH",
          body: JSON.stringify({
            assignees: [{ type: "agent", id: "shared-agent" }],
          }),
          headers: { "Content-Type": "application/json" },
        });

        expect(res.status).toBe(200);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.assignees).toEqual([{ type: "agent", id: "shared-agent" }]);
        expect(fake.tables.kanban_card[0]).toMatchObject({
          assignees: [{ type: "agent", id: "shared-agent" }],
        });
      });

      it("should return 400 for an agent that is not visible in this workspace", async () => {
        mockSession();
        const fake = boardWorld({
          cards: [cardRow()],
          tables: {
            agent: [
              {
                id: "someone-elses-agent",
                organizationId: "org-2",
                workspaceId: null,
                name: "Other Agent",
              },
            ],
          },
        });

        const res = await app.request(`${baseUrl}/${boardId}/cards/card-1`, {
          method: "PATCH",
          body: JSON.stringify({
            assignees: [{ type: "agent", id: "someone-elses-agent" }],
          }),
          headers: { "Content-Type": "application/json" },
        });

        expect(res.status).toBe(400);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.error).toBe("Invalid agent assignee");
        expect(fake.queries).toContainEqual({
          kind: "select",
          table: "agent",
        });
      });

      it("should allow org member to be assigned", async () => {
        mockSession();
        const fake = boardWorld({ cards: [cardRow()] });

        const res = await app.request(`${baseUrl}/${boardId}/cards/card-1`, {
          method: "PATCH",
          body: JSON.stringify({
            assignees: [{ type: "user", id: "user-1" }],
          }),
          headers: { "Content-Type": "application/json" },
        });

        expect(res.status).toBe(200);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.assignees).toEqual([{ type: "user", id: "user-1" }]);
        expect(fake.tables.kanban_card[0]).toMatchObject({
          assignees: [{ type: "user", id: "user-1" }],
        });
      });
    });
  });

  describe("POST /:boardId/cards/:cardId/move", () => {
    it("should move card to beginning of column", async () => {
      mockSession();
      const fake = boardWorld({
        cards: [
          cardRow(),
          cardRow({ id: "card-2", columnId: "col-2", position: 1.0 }),
          cardRow({ id: "card-3", columnId: "col-2", position: 2.0 }),
        ],
      });

      const res = await app.request(`${baseUrl}/${boardId}/cards/card-1/move`, {
        method: "POST",
        body: JSON.stringify({ columnId: "col-2", afterCardId: null }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        id: "card-1",
        columnId: "col-2",
        position: 0.5,
      });
      expect(fake.tables.kanban_card).toContainEqual(
        expect.objectContaining({
          id: "card-1",
          columnId: "col-2",
          position: 0.5,
        }),
      );
    });

    it("should answer 409 when the card has left the expected column", async () => {
      mockSession();
      boardWorld({ cards: [cardRow({ columnId: "col-2" })] });

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
      const fake = boardWorld({
        cards: [
          cardRow(),
          cardRow({ id: "card-2", columnId: "col-2", position: 1.0 }),
          cardRow({ id: "card-3", columnId: "col-2", position: 2.0 }),
        ],
      });

      const res = await app.request(`${baseUrl}/${boardId}/cards/card-1/move`, {
        method: "POST",
        body: JSON.stringify({ columnId: "col-2", afterCardId: "card-2" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        id: "card-1",
        columnId: "col-2",
        position: 1.5,
      });
      expect(fake.tables.kanban_card).toContainEqual(
        expect.objectContaining({
          id: "card-1",
          columnId: "col-2",
          position: 1.5,
        }),
      );
    });

    it("should trigger rebalancing when gap is too small", async () => {
      mockSession();
      const fake = boardWorld({
        cards: [
          cardRow(),
          cardRow({ id: "card-2", columnId: "col-1", position: 1.0 }),
          cardRow({ id: "card-3", columnId: "col-1", position: 1.0000001 }),
        ],
      });

      const res = await app.request(`${baseUrl}/${boardId}/cards/card-1/move`, {
        method: "POST",
        body: JSON.stringify({ columnId: "col-1", afterCardId: "card-2" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        id: "card-1",
        columnId: "col-1",
        position: 2.0,
      });
      expect(fake.tables.kanban_card).toContainEqual(
        expect.objectContaining({ id: "card-3", position: 3.0 }),
      );
    });

    it("should return 400 if afterCardId not found in column", async () => {
      mockSession();
      boardWorld({
        cards: [
          cardRow(),
          cardRow({ id: "card-2", columnId: "col-2", position: 1.0 }),
        ],
      });

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
      boardWorld({
        cards: [
          cardRow({
            id: "card-from-other-board",
            columnId: "col-b",
            title: "Theirs",
          }),
        ],
      });

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
      const fake = boardWorld({ cards: [cardRow()] });

      const res = await app.request(`${baseUrl}/${boardId}/cards/card-1`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Card deleted" });
      expect(fake.tables.kanban_card).toHaveLength(0);
    });

    it("should return 404 if card not found", async () => {
      mockSession();
      boardWorld();

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

  const cardId = "card-1";
  const commentId = "comment-1";
  const commentsUrl = `${baseUrl}/${boardId}/cards/${cardId}/comments`;

  const commentRow = (over: Row = {}): Row => ({
    id: commentId,
    cardId,
    body: "Test comment",
    createdByUserId: null,
    createdByAgentId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...over,
  });

  describe("GET /:boardId/cards/:cardId/comments", () => {
    it("should return 401 if not authenticated", async () => {
      mockNoSession();
      const res = await app.request(commentsUrl);
      expect(res.status).toBe(401);
    });

    it("should return 404 if card not found", async () => {
      mockSession();
      boardWorld();

      const res = await app.request(commentsUrl);
      expect(res.status).toBe(404);
    });

    it("should return comments for card with createdByName resolved", async () => {
      mockSession();
      boardWorld({
        cards: [cardRow()],
        tables: { kanban_card_comment: [commentRow()] },
      });

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
      boardWorld({ cards: [cardRow()] });

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
      boardWorld();

      const res = await app.request(commentsUrl, {
        method: "POST",
        body: JSON.stringify({ body: "A comment" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(404);
    });

    it("should create comment and return 201", async () => {
      mockSession();
      vi.mocked(nanoid).mockReturnValueOnce("test-id-123");
      const fake = boardWorld({ cards: [cardRow()] });

      const res = await app.request(commentsUrl, {
        method: "POST",
        body: JSON.stringify({ body: "Test comment" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.body).toBe("Test comment");
      expect(body.id).toBe("test-id-123");
      expect(fake.tables.kanban_card_comment).toContainEqual(
        expect.objectContaining({
          id: "test-id-123",
          cardId,
          body: "Test comment",
          createdByUserId: "user-1",
        }),
      );
    });

    it("should return 400 if body is empty string", async () => {
      mockSession();
      boardWorld({ cards: [cardRow()] });

      const res = await app.request(commentsUrl, {
        method: "POST",
        body: JSON.stringify({ body: "" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(400);
    });

    it("should return 400 if body field is missing", async () => {
      mockSession();
      boardWorld({ cards: [cardRow()] });

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
        method: "PATCH",
        body: JSON.stringify({ body: "Updated" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(401);
    });

    it("should update comment and return enriched result", async () => {
      mockSession();
      const fake = boardWorld({
        cards: [cardRow()],
        tables: {
          kanban_card_comment: [commentRow({ createdByUserId: "user-1" })],
        },
      });

      const res = await app.request(`${commentsUrl}/${commentId}`, {
        method: "PATCH",
        body: JSON.stringify({ body: "Updated" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { body: string }).body).toBe("Updated");
      expect(fake.tables.kanban_card_comment[0]).toMatchObject({
        body: "Updated",
      });
    });

    it("should return 404 if comment not found", async () => {
      mockSession();
      boardWorld({ cards: [cardRow()] });

      const res = await app.request(`${commentsUrl}/${commentId}`, {
        method: "PATCH",
        body: JSON.stringify({ body: "Updated" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(404);
    });

    it("returns 404 for a comment that belongs to a different card", async () => {
      mockSession();
      const fake = boardWorld({
        cards: [cardRow(), cardRow({ id: "card-2" })],
        tables: {
          kanban_card_comment: [
            commentRow({ cardId: "card-2", createdByUserId: "user-1" }),
          ],
        },
      });

      const res = await app.request(`${commentsUrl}/${commentId}`, {
        method: "PATCH",
        body: JSON.stringify({ body: "Updated" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(404);
      expect(fake.queries).not.toContainEqual({
        kind: "update",
        table: "kanban_card_comment",
      });
      expect(fake.tables.kanban_card_comment[0]).toMatchObject({
        body: "Test comment",
      });
    });

    it("should return 403 if user does not own comment", async () => {
      mockSession({
        id: "other-user",
        email: "other@example.com",
        role: "user",
      });
      boardWorld({
        owner: "other-user",
        members: [
          {
            id: "m1",
            userId: "user-1",
            organizationId: orgId,
            role: "member",
          },
          {
            id: "m2",
            userId: "other-user",
            organizationId: orgId,
            role: "member",
          },
        ],
        cards: [cardRow()],
        tables: {
          kanban_card_comment: [commentRow({ createdByUserId: "user-1" })],
        },
      });

      const res = await app.request(`${commentsUrl}/${commentId}`, {
        method: "PATCH",
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
      const fake = boardWorld({
        owner: "admin-user",
        members: [
          {
            id: "m1",
            userId: "admin-user",
            organizationId: orgId,
            role: "admin",
          },
        ],
        cards: [cardRow()],
        tables: {
          kanban_card_comment: [commentRow({ createdByUserId: "user-1" })],
        },
      });

      const res = await app.request(`${commentsUrl}/${commentId}`, {
        method: "PATCH",
        body: JSON.stringify({ body: "Admin edit" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(200);
      expect(fake.tables.kanban_card_comment[0]).toMatchObject({
        body: "Admin edit",
      });
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
      const fake = boardWorld({
        cards: [cardRow()],
        tables: {
          kanban_card_comment: [commentRow({ createdByUserId: "user-1" })],
        },
      });

      const res = await app.request(`${commentsUrl}/${commentId}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Comment deleted" });
      expect(fake.tables.kanban_card_comment).toHaveLength(0);
    });

    it("should return 404 if comment not found", async () => {
      mockSession();
      boardWorld({ cards: [cardRow()] });

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
      boardWorld({
        owner: "other-user",
        members: [
          {
            id: "m1",
            userId: "user-1",
            organizationId: orgId,
            role: "member",
          },
          {
            id: "m2",
            userId: "other-user",
            organizationId: orgId,
            role: "member",
          },
        ],
        cards: [cardRow()],
        tables: {
          kanban_card_comment: [commentRow({ createdByUserId: "user-1" })],
        },
      });

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
      const fake = boardWorld({
        owner: "admin-user",
        members: [
          {
            id: "m1",
            userId: "admin-user",
            organizationId: orgId,
            role: "admin",
          },
        ],
        cards: [cardRow()],
        tables: {
          kanban_card_comment: [commentRow({ createdByUserId: "user-1" })],
        },
      });

      const res = await app.request(`${commentsUrl}/${commentId}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Comment deleted" });
      expect(fake.tables.kanban_card_comment).toHaveLength(0);
    });
  });
});
