import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  insertTimestamps,
  mockNoSession,
  mockSession,
  resetMockDb,
  seedDb,
  type FakeDb,
  type Row,
} from "../test-utils.ts";
import app from "../server.ts";
import { logger } from "../logger.ts";

describe("Context Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const baseUrl = "/users/me/contexts";
  const userId = "user-1";
  const now = new Date("2026-01-01T00:00:00.000Z");

  const contextRow = (over: Row = {}): Row => ({
    id: "ctx-1",
    userId,
    workspaceId: null,
    content: "Context content",
    createdAt: now,
    updatedAt: now,
    ...over,
  });

  const uniqueContext = {
    name: "unique_context",
    columns: ["userId", "workspaceId"],
  };

  const world = (contexts: Row[] = []): FakeDb =>
    seedDb(
      {
        organization: [{ id: "org-1", name: "Org One" }],
        workspace: [
          {
            id: "ws-1",
            name: "My Workspace",
            organizationId: "org-1",
            ownerId: userId,
          },
          {
            id: "ws-2",
            name: "Someone Else's Workspace",
            organizationId: "org-1",
            ownerId: "someone-else",
          },
          {
            id: "ws-in-org-2",
            name: "Elsewhere",
            organizationId: "org-2",
            ownerId: "someone-else",
          },
        ],
        organization_member: [
          { id: "m1", userId, organizationId: "org-1", role: "member" },
        ],
        context: contexts,
      },
      {
        unique: { context: [uniqueContext] },
        defaults: { context: insertTimestamps() },
      },
    );

  const post = (body: unknown) =>
    app.request(baseUrl, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });

  describe("GET /", () => {
    it("should list all contexts for the authenticated user", async () => {
      mockSession({ id: userId, email: "test@example.com" });
      world([
        contextRow(),
        contextRow({
          id: "ctx-2",
          workspaceId: "ws-1",
          content: "Workspace context content",
        }),
        contextRow({ id: "ctx-other-user", userId: "user-2" }),
      ]);
      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const result = (await res.json()) as { results: Row[] };
      expect(result.results).toEqual([
        {
          id: "ctx-1",
          userId,
          workspaceId: null,
          content: "Context content",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          workspaceName: null,
          organizationName: null,
        },
        {
          id: "ctx-2",
          userId,
          workspaceId: "ws-1",
          content: "Workspace context content",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          workspaceName: "My Workspace",
          organizationName: "Org One",
        },
      ]);
    });

    it("should return 401 if not authenticated", async () => {
      mockNoSession();

      const res = await app.request(baseUrl);
      expect(res.status).toBe(401);
    });
  });

  describe("GET /:contextId", () => {
    it("should get a specific context by ID", async () => {
      mockSession({ id: userId, email: "test@example.com" });
      world([contextRow({ workspaceId: "ws-1" })]);

      const res = await app.request(`${baseUrl}/ctx-1`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        id: "ctx-1",
        userId,
        workspaceId: "ws-1",
        content: "Context content",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        workspaceName: "My Workspace",
        organizationName: "Org One",
      });
    });

    it("should return 404 if context not found", async () => {
      mockSession({ id: userId, email: "test@example.com" });
      world();

      const res = await app.request(`${baseUrl}/ctx-999`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Context not found" });
    });

    it("should return 404 if context belongs to another user", async () => {
      mockSession({ id: userId, email: "test@example.com" });
      world([contextRow({ id: "ctx-other-user", userId: "user-2" })]);

      const res = await app.request(`${baseUrl}/ctx-other-user`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Context not found" });
    });

    it("should return 401 if not authenticated", async () => {
      mockNoSession();

      const res = await app.request(`${baseUrl}/ctx-1`);
      expect(res.status).toBe(401);
    });
  });

  describe("POST /", () => {
    it("should create a global context (null workspaceId)", async () => {
      mockSession({ id: userId, email: "test@example.com" });
      const fake = world();

      const res = await post({
        content: "New global context",
        workspaceId: null,
      });

      expect(res.status).toBe(201);
      const created = fake.tables.context.at(-1)!;
      expect(created).toMatchObject({
        userId,
        workspaceId: null,
        content: "New global context",
      });
      expect(await res.json()).toEqual({
        ...created,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
    });

    it("should create a workspace context", async () => {
      mockSession({ id: userId, email: "test@example.com" });
      const fake = world();

      const res = await post({
        content: "New workspace context",
        workspaceId: "ws-1",
      });

      expect(res.status).toBe(201);
      const created = fake.tables.context.at(-1)!;
      expect(created).toMatchObject({ userId, workspaceId: "ws-1" });
      expect(await res.json()).toEqual({
        ...created,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
    });

    it("should return 409 if context already exists for the scope", async () => {
      mockSession({ id: userId, email: "test@example.com" });
      const fake = world([contextRow({ workspaceId: "ws-1" })]);

      const logError = vi.spyOn(logger, "error");

      const res = await post({
        content: "Duplicate context",
        workspaceId: "ws-1",
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "You already have a context for this scope",
      });
      expect(logError).not.toHaveBeenCalled();
      expect(fake.tables.context).toHaveLength(1);
    });

    it("should return 409 for a second global context", async () => {
      mockSession({ id: userId, email: "test@example.com" });
      const fake = world([contextRow()]);

      const res = await post({
        content: "Another global context",
        workspaceId: null,
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "You already have a context for this scope",
      });
      expect(fake.tables.context).toHaveLength(1);
    });

    it("should validate content is required", async () => {
      mockSession({ id: userId, email: "test@example.com" });
      world();

      const res = await post({});

      expect(res.status).toBe(400);
    });

    it("refuses a workspaceId in an organization the caller is not a member of", async () => {
      mockSession({ id: userId, email: "test@example.com" });
      const fake = world();

      const res = await post({
        content: "Planted context",
        workspaceId: "ws-in-org-2",
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Workspace not found" });
      expect(fake.queries.some((q) => q.kind === "insert")).toBe(false);
    });

    it("refuses a workspaceId owned by another member of the caller's own organization", async () => {
      mockSession({ id: userId, email: "test@example.com" });
      const fake = world();

      const res = await post({
        content: "Planted context",
        workspaceId: "ws-2",
      });

      expect(res.status).toBe(404);
      expect(fake.queries.some((q) => q.kind === "insert")).toBe(false);
    });

    it("refuses a workspaceId that does not exist", async () => {
      mockSession({ id: userId, email: "test@example.com" });
      const fake = world();

      const res = await post({
        content: "Planted context",
        workspaceId: "ws-nope",
      });

      expect(res.status).toBe(404);
      expect(fake.queries.some((q) => q.kind === "insert")).toBe(false);
    });

    it("makes no workspace check for a global context", async () => {
      mockSession({ id: userId, email: "test@example.com" });
      const fake = world();

      const res = await post({ content: "Global", workspaceId: null });

      expect(res.status).toBe(201);
      expect(fake.queries.map((q) => q.kind)).toEqual(["insert"]);
    });

    it("should return 401 if not authenticated", async () => {
      mockNoSession();

      const res = await post({ content: "New context" });

      expect(res.status).toBe(401);
    });
  });

  describe("PUT /:contextId", () => {
    const put = (body: unknown) =>
      app.request(`${baseUrl}/ctx-1`, {
        method: "PUT",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });

    it("should update a context", async () => {
      mockSession({ id: userId, email: "test@example.com" });
      const fake = world([contextRow({ workspaceId: "ws-1" })]);

      const res = await put({ content: "Updated content" });

      expect(res.status).toBe(200);
      const updated = fake.tables.context[0];
      expect(updated).toMatchObject({
        id: "ctx-1",
        userId,
        workspaceId: "ws-1",
        content: "Updated content",
        createdAt: now,
      });
      expect(updated.updatedAt).not.toEqual(now);
      expect(await res.json()).toEqual({
        ...updated,
        createdAt: now.toISOString(),
        updatedAt: (updated.updatedAt as Date).toISOString(),
      });
    });

    it("should return 404 if context not found", async () => {
      mockSession({ id: userId, email: "test@example.com" });
      world();

      const res = await app.request(`${baseUrl}/ctx-999`, {
        method: "PUT",
        body: JSON.stringify({ content: "Updated content" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Context not found" });
    });

    it("should return 404 if context belongs to another user", async () => {
      mockSession({ id: userId, email: "test@example.com" });
      const fake = world([
        contextRow({ id: "ctx-other-user", userId: "user-2" }),
      ]);

      const res = await app.request(`${baseUrl}/ctx-other-user`, {
        method: "PUT",
        body: JSON.stringify({ content: "Updated content" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Context not found" });
      expect(fake.tables.context[0]).toMatchObject({
        content: "Context content",
      });
    });

    it("should validate content is required", async () => {
      mockSession({ id: userId, email: "test@example.com" });
      world([contextRow({ workspaceId: "ws-1" })]);

      const res = await put({});

      expect(res.status).toBe(400);
    });

    it("should return 401 if not authenticated", async () => {
      mockNoSession();

      const res = await put({ content: "Updated content" });

      expect(res.status).toBe(401);
    });
  });

  describe("DELETE /:contextId", () => {
    it("should delete a context", async () => {
      mockSession({ id: userId, email: "test@example.com" });
      const fake = world([
        contextRow({ workspaceId: "ws-1", content: "Context to delete" }),
      ]);

      const res = await app.request(`${baseUrl}/ctx-1`, { method: "DELETE" });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Context deleted" });
      expect(fake.tables.context).toEqual([]);
      expect(
        fake.queries.filter((q) => q.kind === "delete").map((q) => q.table),
      ).toEqual(["context"]);
    });

    it("should return 404 if context not found", async () => {
      mockSession({ id: userId, email: "test@example.com" });
      world();

      const res = await app.request(`${baseUrl}/ctx-999`, { method: "DELETE" });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Context not found" });
    });

    it("should return 404 if context belongs to another user", async () => {
      mockSession({ id: userId, email: "test@example.com" });
      const fake = world([
        contextRow({ id: "ctx-other-user", userId: "user-2" }),
      ]);

      const res = await app.request(`${baseUrl}/ctx-other-user`, {
        method: "DELETE",
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Context not found" });
      expect(fake.tables.context.map((c) => c.id)).toEqual(["ctx-other-user"]);
    });

    it("should return 401 if not authenticated", async () => {
      mockNoSession();

      const res = await app.request(`${baseUrl}/ctx-1`, { method: "DELETE" });

      expect(res.status).toBe(401);
    });
  });
});
