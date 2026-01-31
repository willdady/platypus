import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, mockSession, mockNoSession, resetMockDb } from "../test-utils.ts";
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
      const result = await res.json();
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
      expect(await res.json()).toEqual({ message: "Context not found" });
    });

    it("should return 404 if context belongs to another user", async () => {
      mockSession({ id: userId, email: "test@example.com" });

      // Simulate no results when filtering by both contextId and userId
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/ctx-other-user`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ message: "Context not found" });
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

    it("should create a workspace context", async () => {
      mockSession({ id: userId, email: "test@example.com" });

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
        message: "You already have a context for this scope",
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
      expect(await res.json()).toEqual({ message: "Context not found" });
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
      expect(await res.json()).toEqual({ message: "Context not found" });
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
      expect(await res.json()).toEqual({ message: "Context not found" });
    });

    it("should return 404 if context belongs to another user", async () => {
      mockSession({ id: userId, email: "test@example.com" });

      // Simulate no results when filtering by both contextId and userId
      mockDb.returning.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/ctx-other-user`, {
        method: "DELETE",
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ message: "Context not found" });
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
