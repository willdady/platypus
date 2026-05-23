import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, mockSession, resetMockDb } from "../test-utils.ts";
import app from "../server.ts";

describe("Sandbox Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
  });

  const orgId = "org-1";
  const workspaceId = "ws-1";
  const baseUrl = `/organizations/${orgId}/workspaces/${workspaceId}/sandbox`;

  const validBody = {
    workspaceId,
    name: "Local Docker",
    backend: "docker",
    config: { image: "debian:stable-slim" },
    credentials: { token: "secret-123" },
  };

  describe("POST /", () => {
    it("creates a sandbox and returns 201 with credentials stripped", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([]); // existing-row check

      mockDb.returning.mockResolvedValueOnce([
        {
          id: "sbx-1",
          workspaceId,
          name: "Local Docker",
          backend: "docker",
          config: { image: "debian:stable-slim" },
          credentials: { token: "secret-123" },
        },
      ]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify(validBody),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).not.toHaveProperty("credentials");
      expect(body.id).toBe("sbx-1");
      expect(body.backend).toBe("docker");
    });

    it("returns 409 when a sandbox already exists for the workspace", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);
      mockDb.limit.mockResolvedValueOnce([{ id: "existing-sbx" }]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify(validBody),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(409);
    });
  });

  describe("GET /", () => {
    it("returns the sandbox with credentials stripped", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);
      mockDb.limit.mockResolvedValueOnce([
        {
          id: "sbx-1",
          workspaceId,
          name: "Local Docker",
          backend: "docker",
          config: {},
          credentials: { token: "secret-123" },
        },
      ]);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).not.toHaveProperty("credentials");
      expect(body.id).toBe("sbx-1");
    });

    it("returns 404 when no sandbox is configured", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /", () => {
    it("updates the sandbox and returns it with credentials stripped", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);

      mockDb.returning.mockResolvedValueOnce([
        {
          id: "sbx-1",
          workspaceId,
          name: "Renamed",
          backend: "docker",
          config: {},
          credentials: { token: "rotated" },
        },
      ]);

      const res = await app.request(baseUrl, {
        method: "PUT",
        body: JSON.stringify({
          name: "Renamed",
          backend: "docker",
          config: {},
          credentials: { token: "rotated" },
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).not.toHaveProperty("credentials");
      expect(body.name).toBe("Renamed");
    });

    it("returns 404 when no sandbox is configured", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);
      mockDb.returning.mockResolvedValueOnce([]);

      const res = await app.request(baseUrl, {
        method: "PUT",
        body: JSON.stringify({
          name: "Renamed",
          backend: "docker",
          config: {},
          credentials: {},
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /", () => {
    it("deletes the sandbox", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);

      mockDb.returning.mockResolvedValueOnce([{ id: "sbx-1" }]);

      const res = await app.request(baseUrl, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Sandbox deleted" });
    });

    it("returns 404 when no sandbox is configured", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);

      mockDb.returning.mockResolvedValueOnce([]);

      const res = await app.request(baseUrl, { method: "DELETE" });
      expect(res.status).toBe(404);
    });
  });
});
