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
    it("updates the sandbox when the backend is unchanged", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);
      // Existence check — same backend, no destroy will fire
      mockDb.limit.mockResolvedValueOnce([
        {
          id: "sbx-1",
          workspaceId,
          backend: "docker",
          config: {},
          credentials: {},
        },
      ]);

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

    it("returns 500 when changing backend and the previous adapter's destroy() fails", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);
      // Existing row uses an unregistered backend → destroy throws
      mockDb.limit.mockResolvedValueOnce([
        {
          id: "sbx-1",
          workspaceId,
          backend: "no-such-backend",
          config: {},
          credentials: {},
        },
      ]);

      const res = await app.request(baseUrl, {
        method: "PUT",
        body: JSON.stringify({
          name: "Switched",
          backend: "another-backend",
          config: {},
          credentials: {},
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toMatch(/force=true/);
    });

    it("skips destroy() and switches backend when ?force=true", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);
      mockDb.limit.mockResolvedValueOnce([
        {
          id: "sbx-1",
          workspaceId,
          backend: "no-such-backend",
          config: {},
          credentials: {},
        },
      ]);

      mockDb.returning.mockResolvedValueOnce([
        {
          id: "sbx-1",
          workspaceId,
          name: "Switched",
          backend: "another-backend",
          config: {},
          credentials: {},
        },
      ]);

      const res = await app.request(`${baseUrl}?force=true`, {
        method: "PUT",
        body: JSON.stringify({
          name: "Switched",
          backend: "another-backend",
          config: {},
          credentials: {},
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
    });

    it("returns 404 when no sandbox is configured", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);
      // Existence check returns empty
      mockDb.limit.mockResolvedValueOnce([]);

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
    it("force-deletes the sandbox without invoking destroy()", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);
      // Existence check
      mockDb.limit.mockResolvedValueOnce([
        {
          id: "sbx-1",
          workspaceId,
          backend: "docker",
          config: {},
          credentials: {},
        },
      ]);

      const res = await app.request(`${baseUrl}?force=true`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Sandbox deleted" });
    });

    it("returns 500 when destroy() fails and preserves the row", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);
      // Existence check returns a row whose backend is not registered →
      // destroySandboxRow throws → 500.
      mockDb.limit.mockResolvedValueOnce([
        {
          id: "sbx-1",
          workspaceId,
          backend: "no-such-backend",
          config: {},
          credentials: {},
        },
      ]);

      const res = await app.request(baseUrl, { method: "DELETE" });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toMatch(/no-such-backend/);
      expect(body.error).toMatch(/force=true/);
    });

    it("returns 404 when no sandbox is configured", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);
      // Existence check returns empty
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await app.request(baseUrl, { method: "DELETE" });
      expect(res.status).toBe(404);
    });
  });
});
