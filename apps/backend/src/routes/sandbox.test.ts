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

  describe("GET /backends", () => {
    it("returns the list of registered backends with name and id only", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);

      const res = await app.request(`${baseUrl}/backends`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: Array<{ backend: string; name: string }>;
      };
      // The registry is process-wide; tests don't register the Docker adapter
      // (no PLATYPUS_SANDBOX_DOCKER_ENABLED), so the list shape is what we
      // assert — not specific entries.
      expect(Array.isArray(body.results)).toBe(true);
      for (const r of body.results) {
        expect(typeof r.backend).toBe("string");
        expect(typeof r.name).toBe("string");
        expect(Object.keys(r).sort()).toEqual(["backend", "name"]);
      }
    });
  });

  describe("POST /", () => {
    it("creates a sandbox and returns 201 with credentials stripped", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
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
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
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
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
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
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
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
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
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
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
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
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
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
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
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
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);
      // Existence check returns empty
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await app.request(baseUrl, { method: "DELETE" });
      expect(res.status).toBe(404);
    });
  });

  // ADR-0006: Sandbox configuration is org-admin-only and never delegatable.
  describe("authorization (ADR-0006)", () => {
    it("POST / returns 403 for a non-admin workspace owner", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess (owner)

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify(validBody),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(403);
    });

    it("DELETE / returns 403 for a non-admin workspace owner", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);

      const res = await app.request(baseUrl, { method: "DELETE" });
      expect(res.status).toBe(403);
    });

    it("GET /networks returns 403 for a non-admin workspace owner", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);

      const res = await app.request(`${baseUrl}/networks`);
      expect(res.status).toBe(403);
    });

    it("POST / rejects userEnv keys that collide with adminEnv (400)", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          ...validBody,
          adminEnv: { SHARED: "a" },
          userEnv: { SHARED: "b" },
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/SHARED/);
    });

    it("PUT / lets a non-admin owner change name and userEnv only", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess
      // Existing row: admin-owned backend/config plus an admin env key.
      mockDb.limit.mockResolvedValueOnce([
        {
          id: "sbx-1",
          workspaceId,
          name: "Old",
          backend: "docker",
          config: { networks: ["shared"] },
          adminEnv: { ADMIN_KEY: "x" },
          userEnv: {},
        },
      ]);
      mockDb.returning.mockResolvedValueOnce([
        {
          id: "sbx-1",
          workspaceId,
          name: "New",
          backend: "docker",
          config: { networks: ["shared"] },
          adminEnv: { ADMIN_KEY: "x" },
          userEnv: { MY_KEY: "y" },
        },
      ]);

      const res = await app.request(baseUrl, {
        method: "PUT",
        // Owner attempts to also change backend — must be ignored, not 500/escalated.
        body: JSON.stringify({
          name: "New",
          backend: "evil-backend",
          userEnv: { MY_KEY: "y" },
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(200);
      // Only name + userEnv were written.
      const setArg = mockDb.set.mock.calls.at(-1)?.[0];
      expect(setArg).toMatchObject({ name: "New", userEnv: { MY_KEY: "y" } });
      expect(setArg).not.toHaveProperty("backend");
      expect(setArg).not.toHaveProperty("config");
    });

    it("PUT / rejects a non-admin owner's userEnv that collides with stored adminEnv (400)", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);
      mockDb.limit.mockResolvedValueOnce([
        {
          id: "sbx-1",
          workspaceId,
          name: "Old",
          backend: "docker",
          adminEnv: { ADMIN_KEY: "x" },
          userEnv: {},
        },
      ]);

      const res = await app.request(baseUrl, {
        method: "PUT",
        body: JSON.stringify({
          name: "Old",
          backend: "docker",
          userEnv: { ADMIN_KEY: "hijack" },
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/ADMIN_KEY/);
    });
  });
});
