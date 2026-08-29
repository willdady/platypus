import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockDb,
  mockSession,
  mockNoSession,
  resetMockDb,
} from "../test-utils.ts";
import app from "../server.ts";

describe("Context Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
    mockDb.leftJoin.mockReturnValue(mockDb);
  });

  const baseUrl = "/users/me/contexts";
  const userId = "user-1";

  describe("GET /", () => {
    it("should list all contexts for the authenticated user", async () => {
      mockSession({ id: userId, email: "test@example.com" });

      const now = new Date();
      const mockContexts = [
        {
          id: "ctx-1",
          userId,
          workspaceId: null,
          content: "Global context content",
          createdAt: now,
          updatedAt: now,
          workspaceName: null,
        },
        {
          id: "ctx-2",
          userId,
          workspaceId: "ws-1",
          content: "Workspace context content",
          createdAt: now,
          updatedAt: now,
          workspaceName: "My Workspace",
        },
      ];

      mockDb.orderBy.mockResolvedValueOnce(mockContexts);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const result = (await res.json()) as Record<string, unknown>;
      expect(result).toEqual({
        results: mockContexts.map((ctx) => ({
          ...ctx,
          createdAt: ctx.createdAt.toISOString(),
          updatedAt: ctx.updatedAt.toISOString(),
        })),
      });
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

      const now = new Date();
      const mockContext = {
        id: "ctx-1",
        userId,
        workspaceId: "ws-1",
        content: "Context content",
        createdAt: now,
        updatedAt: now,
        workspaceName: "My Workspace",
      };

      mockDb.limit.mockResolvedValueOnce([mockContext]);

      const res = await app.request(`${baseUrl}/ctx-1`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ...mockContext,
        createdAt: mockContext.createdAt.toISOString(),
        updatedAt: mockContext.updatedAt.toISOString(),
      });
    });

    it("should return 404 if context not found", async () => {
      mockSession({ id: userId, email: "test@example.com" });

      mockDb.limit.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/ctx-999`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Context not found" });
    });

    it("should return 404 if context belongs to another user", async () => {
      mockSession({ id: userId, email: "test@example.com" });

      // Simulate no results when filtering by both contextId and userId
      mockDb.limit.mockResolvedValueOnce([]);

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
    it("should create a global context (no workspaceId)", async () => {
      mockSession({ id: userId, email: "test@example.com" });

      const now = new Date();
      const mockContext = {
        id: "ctx-new",
        userId,
        workspaceId: null,
        content: "New global context",
        createdAt: now,
        updatedAt: now,
      };

      mockDb.returning.mockResolvedValueOnce([mockContext]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          content: "New global context",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({
        ...mockContext,
        createdAt: mockContext.createdAt.toISOString(),
        updatedAt: mockContext.updatedAt.toISOString(),
      });
      expect(mockDb.insert).toHaveBeenCalled();
    });

    // The three lookups `userMayUseWorkspace` makes, in order: the Workspace's
    // Organization, the caller's membership of it, then the Workspace itself.
    const mockWorkspaceReachable = () => {
      mockDb.limit.mockResolvedValueOnce([{ organizationId: "org-1" }]);
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([
        { id: "ws-1", organizationId: "org-1", ownerId: userId },
      ]);
    };

    it("should create a workspace context", async () => {
      mockSession({ id: userId, email: "test@example.com" });
      mockWorkspaceReachable();

      const now = new Date();
      const mockContext = {
        id: "ctx-new",
        userId,
        workspaceId: "ws-1",
        content: "New workspace context",
        createdAt: now,
        updatedAt: now,
      };

      mockDb.returning.mockResolvedValueOnce([mockContext]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          content: "New workspace context",
          workspaceId: "ws-1",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({
        ...mockContext,
        createdAt: mockContext.createdAt.toISOString(),
        updatedAt: mockContext.updatedAt.toISOString(),
      });
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it("should return 409 if context already exists for the scope", async () => {
      mockSession({ id: userId, email: "test@example.com" });
      mockWorkspaceReachable();

      // Mock unique constraint violation
      mockDb.returning.mockRejectedValueOnce({ code: "23505" });

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          content: "Duplicate context",
          workspaceId: "ws-1",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "You already have a context for this scope",
      });
    });

    it("should validate content is required", async () => {
      mockSession({ id: userId, email: "test@example.com" });

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
    });

    // This route has no Organization in its path, so the Workspace arrives in
    // the body with nothing upstream having proved the caller may name it.
    // Every refusal reads as "not found", whatever the reason — a caller who
    // named an id they have no claim to learns nothing about it, not even
    // whether it exists.
    it("refuses a workspaceId in an organization the caller is not a member of", async () => {
      mockSession({ id: userId, email: "test@example.com" });
      mockDb.limit.mockResolvedValueOnce([{ organizationId: "org-2" }]);
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          content: "Planted context",
          workspaceId: "ws-in-org-2",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Workspace not found" });
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("refuses a workspaceId owned by another member of the caller's own organization", async () => {
      mockSession({ id: userId, email: "test@example.com" });
      mockDb.limit.mockResolvedValueOnce([{ organizationId: "org-1" }]);
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([
        { id: "ws-2", organizationId: "org-1", ownerId: "someone-else" },
      ]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          content: "Planted context",
          workspaceId: "ws-2",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(404);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("refuses a workspaceId that does not exist", async () => {
      mockSession({ id: userId, email: "test@example.com" });
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          content: "Planted context",
          workspaceId: "ws-nope",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(404);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    // A global Context names no Workspace, so there is nothing to check and no
    // lookup to make — the guard must not turn a null scope into a 404.
    it("makes no workspace check for a global context", async () => {
      mockSession({ id: userId, email: "test@example.com" });
      mockDb.returning.mockResolvedValueOnce([
        { id: "ctx-new", userId, workspaceId: null, content: "Global" },
      ]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({ content: "Global" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      expect(mockDb.limit).not.toHaveBeenCalled();
    });

    it("should return 401 if not authenticated", async () => {
      mockNoSession();

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          content: "New context",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(401);
    });
  });

  describe("PUT /:contextId", () => {
    it("should update a context", async () => {
      mockSession({ id: userId, email: "test@example.com" });

      const now = new Date();
      const updatedContext = {
        id: "ctx-1",
        userId,
        workspaceId: "ws-1",
        content: "Updated content",
        createdAt: now,
        updatedAt: now,
      };

      mockDb.returning.mockResolvedValueOnce([updatedContext]);

      const res = await app.request(`${baseUrl}/ctx-1`, {
        method: "PUT",
        body: JSON.stringify({
          content: "Updated content",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ...updatedContext,
        createdAt: updatedContext.createdAt.toISOString(),
        updatedAt: updatedContext.updatedAt.toISOString(),
      });
      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb.set).toHaveBeenCalled();
    });

    it("should return 404 if context not found", async () => {
      mockSession({ id: userId, email: "test@example.com" });

      mockDb.returning.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/ctx-999`, {
        method: "PUT",
        body: JSON.stringify({
          content: "Updated content",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Context not found" });
    });

    it("should return 404 if context belongs to another user", async () => {
      mockSession({ id: userId, email: "test@example.com" });

      // Simulate no results when filtering by both contextId and userId
      mockDb.returning.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/ctx-other-user`, {
        method: "PUT",
        body: JSON.stringify({
          content: "Updated content",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Context not found" });
    });

    it("should validate content is required", async () => {
      mockSession({ id: userId, email: "test@example.com" });

      const res = await app.request(`${baseUrl}/ctx-1`, {
        method: "PUT",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
    });

    it("should return 401 if not authenticated", async () => {
      mockNoSession();

      const res = await app.request(`${baseUrl}/ctx-1`, {
        method: "PUT",
        body: JSON.stringify({
          content: "Updated content",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(401);
    });
  });

  describe("DELETE /:contextId", () => {
    it("should delete a context", async () => {
      mockSession({ id: userId, email: "test@example.com" });

      const deletedContext = {
        id: "ctx-1",
        userId,
        workspaceId: "ws-1",
        content: "Context to delete",
      };

      mockDb.returning.mockResolvedValueOnce([deletedContext]);

      const res = await app.request(`${baseUrl}/ctx-1`, {
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        message: "Context deleted successfully",
      });
      expect(mockDb.delete).toHaveBeenCalled();
    });

    it("should return 404 if context not found", async () => {
      mockSession({ id: userId, email: "test@example.com" });

      mockDb.returning.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/ctx-999`, {
        method: "DELETE",
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Context not found" });
    });

    it("should return 404 if context belongs to another user", async () => {
      mockSession({ id: userId, email: "test@example.com" });

      // Simulate no results when filtering by both contextId and userId
      mockDb.returning.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/ctx-other-user`, {
        method: "DELETE",
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Context not found" });
    });

    it("should return 401 if not authenticated", async () => {
      mockNoSession();

      const res = await app.request(`${baseUrl}/ctx-1`, {
        method: "DELETE",
      });

      expect(res.status).toBe(401);
    });
  });
});
