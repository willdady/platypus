import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";
import {
  loadedPluginsFixture,
  mockDb,
  mockSession,
  resetMockDb,
} from "../test-utils.ts";
import app from "../server.ts";
import {
  registerSandboxBackend,
  type SandboxBackend,
} from "../sandbox/index.ts";
import { SANDBOX_TRANSFER_MAX_BYTES } from "@platypuschat/plugin-sdk";
import { setLoadedPlugins } from "../plugins/registry.ts";
import { logger } from "../logger.ts";

// Register a backend directly (bypassing the loader) so the route has a stable
// entry to write against, and record its owning plugin in the registry so the
// annotation (ADR-0013) has something to resolve.
const ANNOTATED_BACKEND = "test-annotated";
registerSandboxBackend({
  backend: ANNOTATED_BACKEND,
  name: "Test Annotated",
  configSchema: z.object({}),
  credentialsSchema: z.object({}),
  create: () => {
    throw new Error("not used in this test");
  },
});

// A backend whose credentials schema requires a field, so the route's
// credentials validation (ADR-0012 / ADR-0013) has something to reject against.
const CREDS_BACKEND = "test-creds";
registerSandboxBackend({
  backend: CREDS_BACKEND,
  name: "Test Creds",
  configSchema: z.object({}).strict(),
  credentialsSchema: z.object({ privateKey: z.string().min(1) }).strict(),
  create: () => {
    throw new Error("not used in this test");
  },
});

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
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
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
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).not.toHaveProperty("credentials");
      expect(body.hasCredentials).toBe(true);
      expect(body.id).toBe("sbx-1");
      expect(body.backend).toBe("docker");
    });

    it("returns 400 when credentials fail the backend's schema", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          workspaceId,
          name: "Creds backend",
          backend: CREDS_BACKEND,
          config: {},
          credentials: {}, // missing required privateKey
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toMatch(/Invalid sandbox credentials/);
    });

    it("returns 409 when a sandbox already exists for the workspace", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
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
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
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
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).not.toHaveProperty("credentials");
      expect(body.id).toBe("sbx-1");
    });

    // Issue #1056: the settings form needs to know a key is stored, and no
    // caller ever gets the key back, admins included.
    it.each([
      ["admin", { privateKey: "PRIVATE-KEY", passphrase: "PASSPHRASE" }, true],
      ["member", { privateKey: "PRIVATE-KEY", passphrase: "PASSPHRASE" }, true],
      ["admin", {}, false],
      ["member", {}, false],
      ["member", null, false],
    ])(
      "tells a %s whether credentials are stored (%j → %s), never what they are",
      async (role, credentials, hasCredentials) => {
        mockSession();
        mockDb.limit.mockResolvedValueOnce([{ role }]);
        mockDb.limit.mockResolvedValueOnce([
          { ownerId: "user-1", organizationId: "org-1" },
        ]);
        mockDb.limit.mockResolvedValueOnce([
          {
            id: "sbx-1",
            workspaceId,
            name: "SSH host",
            backend: "ssh",
            config: { host: "ssh.example.com", user: "platypus" },
            credentials,
            adminEnv: {},
            userEnv: {},
          },
        ]);

        const res = await app.request(baseUrl);
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(JSON.parse(text)).toMatchObject({ hasCredentials });
        expect(text).not.toMatch(
          /"credentials"|privateKey|passphrase|PRIVATE-KEY|PASSPHRASE/,
        );
      },
    );

    it("returns 404 when no sandbox is configured", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /", () => {
    it("updates the sandbox when the backend is unchanged", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
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
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).not.toHaveProperty("credentials");
      expect(body.hasCredentials).toBe(true);
      expect(body.name).toBe("Renamed");
    });

    it("returns 500 when changing backend and the previous adapter's destroy() fails", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
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
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toMatch(/force=true/);
    });

    it("skips destroy() and switches backend when ?force=true", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
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

    it("attributes the force-change leak warning to the outgoing backend's plugin", async () => {
      // The adapter that was skipped is the one that may have leaked, so it is
      // the one `backend`/`plugin` name — the incoming backend rides along as
      // `replacedBy` so neither key can be read as spanning both.
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      mockDb.limit.mockResolvedValueOnce([
        {
          id: "sbx-1",
          workspaceId,
          backend: ANNOTATED_BACKEND,
          config: {},
          credentials: {},
        },
      ]);
      mockDb.returning.mockResolvedValueOnce([
        {
          id: "sbx-1",
          workspaceId,
          name: "Switched",
          backend: CREDS_BACKEND,
          config: {},
          credentials: {},
        },
      ]);
      setLoadedPlugins(
        loadedPluginsFixture([], {
          sandboxBackends: new Map([
            [ANNOTATED_BACKEND, "@platypus/outgoing"],
            [CREDS_BACKEND, "@platypus/incoming"],
          ]),
        }),
      );
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

      await app.request(`${baseUrl}?force=true`, {
        method: "PUT",
        body: JSON.stringify({
          name: "Switched",
          backend: CREDS_BACKEND,
          config: {},
          credentials: { privateKey: "k" },
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          backend: ANNOTATED_BACKEND,
          plugin: "@platypus/outgoing",
          replacedBy: CREDS_BACKEND,
        }),
        expect.stringContaining("external resources may leak"),
      );
      // The plugin taking over has leaked nothing and must not be named here.
      expect(warn).not.toHaveBeenCalledWith(
        expect.objectContaining({ plugin: "@platypus/incoming" }),
        expect.anything(),
      );
      warn.mockRestore();
    });

    it("returns 404 when no sandbox is configured", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
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
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
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

    it("names the owning plugin on the force-delete leak warning", async () => {
      // Core's own line about a plugin's adapter carries the plugin under the
      // same `plugin` key the adapter's own lines do, so an Operator filtering
      // by plugin sees core's half of the story too.
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      mockDb.limit.mockResolvedValueOnce([
        {
          id: "sbx-1",
          workspaceId,
          backend: ANNOTATED_BACKEND,
          config: {},
          credentials: {},
        },
      ]);
      setLoadedPlugins(
        loadedPluginsFixture([], {
          sandboxBackends: new Map([[ANNOTATED_BACKEND, "@platypus/test"]]),
        }),
      );
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

      const res = await app.request(`${baseUrl}?force=true`, {
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          backend: ANNOTATED_BACKEND,
          plugin: "@platypus/test",
          sandboxId: "sbx-1",
        }),
        expect.stringContaining("external resources may leak"),
      );
      warn.mockRestore();
    });

    it("reports no owner rather than omitting the key for an unowned backend", async () => {
      // A backend belonging to no loaded plugin is a real state (the plugin was
      // dropped from PLATYPUS_PLUGINS). `null` says "no owner"; an absent key
      // would read as "not asked", and the line would drop out of a filter that
      // is looking for exactly this case.
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      mockDb.limit.mockResolvedValueOnce([
        {
          id: "sbx-1",
          workspaceId,
          backend: "no-such-backend",
          config: {},
          credentials: {},
        },
      ]);
      setLoadedPlugins(loadedPluginsFixture());
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

      await app.request(`${baseUrl}?force=true`, { method: "DELETE" });

      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          backend: "no-such-backend",
          plugin: null,
        }),
        expect.stringContaining("external resources may leak"),
      );
      warn.mockRestore();
    });

    it("returns 500 when destroy() fails and preserves the row", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
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
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toMatch(/no-such-backend/);
      expect(body.error).toMatch(/force=true/);
    });

    it("returns 404 when no sandbox is configured", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
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
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess (owner)

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
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);

      const res = await app.request(baseUrl, { method: "DELETE" });
      expect(res.status).toBe(403);
    });

    it("POST / rejects userEnv keys that collide with adminEnv (400)", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);

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
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toMatch(/SHARED/);
    });

    it("PUT / lets a non-admin owner change name and userEnv only", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
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
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
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
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toMatch(/ADMIN_KEY/);
    });
  });

  describe("admin input validation", () => {
    const stored = {
      id: "sbx-1",
      workspaceId,
      name: "Creds backend",
      backend: CREDS_BACKEND,
      config: {},
      adminEnv: { ADMIN_KEY: "x" },
      userEnv: {},
    };

    const asAdmin = (existing?: unknown) => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      if (existing) mockDb.limit.mockResolvedValueOnce([existing]);
    };

    const send = (method: "POST" | "PUT", body: unknown) =>
      app.request(baseUrl, {
        method,
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });

    it.each([
      [
        "POST: config failing the backend's schema",
        "POST",
        { config: { unexpected: true }, credentials: { privateKey: "k" } },
        /^Invalid sandbox config: /,
      ],
      [
        "PUT: config failing the backend's schema",
        "PUT",
        { config: { unexpected: true } },
        /^Invalid sandbox config: /,
      ],
      [
        "PUT: credentials failing the backend's schema",
        "PUT",
        { config: {}, credentials: {} },
        /^Invalid sandbox credentials: /,
      ],
      [
        "PUT: userEnv colliding with the stored adminEnv",
        "PUT",
        { config: {}, userEnv: { ADMIN_KEY: "y" } },
        /ADMIN_KEY/,
      ],
    ] as const)("rejects %s (400)", async (_label, method, over, error) => {
      asAdmin(method === "PUT" ? stored : undefined);

      const res = await send(method, {
        workspaceId,
        name: "Creds backend",
        backend: CREDS_BACKEND,
        ...over,
      });

      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(error);
      expect(mockDb.insert).not.toHaveBeenCalled();
      expect(mockDb.update).not.toHaveBeenCalled();
    });
  });
});

// Issue #1068 / ADR-0027: moving a file in or out of the Sandbox without the
// model.
describe("Sandbox file transfer", () => {
  const TRANSFER_BACKEND = "test-transfer";
  const BARE_BACKEND = "test-bare";
  const fsList = vi.fn();
  const fsReadBytes = vi.fn();
  const fsWriteBytes = vi.fn();
  registerSandboxBackend({
    backend: TRANSFER_BACKEND,
    name: "Test Transfer",
    configSchema: z.object({}),
    credentialsSchema: z.object({}),
    create: () =>
      ({ fsList, fsReadBytes, fsWriteBytes }) as unknown as SandboxBackend,
  });
  registerSandboxBackend({
    backend: BARE_BACKEND,
    name: "Test Bare",
    configSchema: z.object({}),
    credentialsSchema: z.object({}),
    create: () => ({ fsList }) as unknown as SandboxBackend,
  });

  const fileUrl = `/organizations/org-1/workspaces/ws-1/sandbox/file`;

  const row = (backend = TRANSFER_BACKEND) => ({
    id: "sbx-1",
    workspaceId: "ws-1",
    name: "Box",
    backend,
    config: {},
    credentials: {},
    adminEnv: {},
    userEnv: {},
  });

  // requireOrgAccess, requireWorkspaceAccess, the sandbox row, then the
  // Workspace owner lookup that builds the adapter's context.
  const mockAccess = (backend = TRANSFER_BACKEND, role = "member") => {
    mockSession();
    mockDb.limit.mockResolvedValueOnce([{ role }]);
    mockDb.limit.mockResolvedValueOnce([
      { ownerId: "user-1", organizationId: "org-1" },
    ]);
    mockDb.limit.mockResolvedValueOnce([row(backend)]);
    mockDb.limit.mockResolvedValueOnce([{ orgId: "org-1", userId: "user-1" }]);
  };

  const listing = (path: string, size: number, type = "file") => ({
    entries: [{ path, type, size }],
    truncated: false,
  });

  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
    fsList.mockReset();
    fsReadBytes.mockReset();
    fsWriteBytes.mockReset();
  });

  describe("GET / reports which directions the backend supports", () => {
    it.each([
      [TRANSFER_BACKEND, { upload: true, download: true }],
      [BARE_BACKEND, { upload: false, download: false }],
    ])("%s → %j", async (backend, transfer) => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      mockDb.limit.mockResolvedValueOnce([row(backend)]);

      const res = await app.request(
        `/organizations/org-1/workspaces/ws-1/sandbox`,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ transfer });
    });
  });

  describe("GET /file (download)", () => {
    it("serves the bytes as an attachment that never renders inline", async () => {
      mockAccess();
      const bytes = new Uint8Array([0x3c, 0x68, 0x31, 0x3e, 0x00, 0xff]);
      fsList.mockResolvedValueOnce(listing("page.html", bytes.length));
      fsReadBytes.mockResolvedValueOnce(bytes);

      const res = await app.request(`${fileUrl}?path=site/page.html`);

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
      expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
      expect(res.headers.get("content-disposition")).toContain(
        "filename*=UTF-8''page.html",
      );
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
      expect(fsList).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: "ws-1" }),
        expect.objectContaining({ path: "site" }),
        expect.anything(),
      );
      expect(fsReadBytes).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: "ws-1" }),
        { path: "site/page.html", maxBytes: SANDBOX_TRANSFER_MAX_BYTES },
        expect.objectContaining({
          signal: expect.any(AbortSignal) as AbortSignal,
        }),
      );
    });

    it("encodes a filename that is not plain ASCII", async () => {
      mockAccess();
      fsList.mockResolvedValueOnce(listing('ré"sumé.pdf', 1));
      fsReadBytes.mockResolvedValueOnce(new Uint8Array([1]));

      const res = await app.request(
        `${fileUrl}?path=${encodeURIComponent('ré"sumé.pdf')}`,
      );

      expect(res.headers.get("content-disposition")).toBe(
        `attachment; filename*=UTF-8''r%C3%A9%22sum%C3%A9.pdf`,
      );
    });

    it("serves a file of exactly the bound", async () => {
      mockAccess();
      fsList.mockResolvedValueOnce(
        listing("big.bin", SANDBOX_TRANSFER_MAX_BYTES),
      );
      fsReadBytes.mockResolvedValueOnce(
        new Uint8Array(SANDBOX_TRANSFER_MAX_BYTES),
      );

      const res = await app.request(`${fileUrl}?path=big.bin`);

      expect(res.status).toBe(200);
      expect((await res.arrayBuffer()).byteLength).toBe(
        SANDBOX_TRANSFER_MAX_BYTES,
      );
    });

    it("answers 413 for a file one byte over the bound, without reading it", async () => {
      mockAccess();
      fsList.mockResolvedValueOnce(
        listing("big.bin", SANDBOX_TRANSFER_MAX_BYTES + 1),
      );

      const res = await app.request(`${fileUrl}?path=big.bin`);

      expect(res.status).toBe(413);
      expect(fsReadBytes).not.toHaveBeenCalled();
    });

    it.each([
      ["the parent holds no such file", () => Promise.resolve({ entries: [] })],
      [
        "the path is a directory",
        () => Promise.resolve(listing("dir", 0, "dir")),
      ],
    ])("answers 404 when %s", async (_, list) => {
      mockAccess();
      fsList.mockImplementationOnce(list);

      const res = await app.request(`${fileUrl}?path=dir`);

      expect(res.status).toBe(404);
      expect(fsReadBytes).not.toHaveBeenCalled();
    });

    it("answers 404 when the parent directory is missing", async () => {
      mockAccess();
      fsList
        .mockRejectedValueOnce(new Error("fs.list: No such file or directory"))
        .mockResolvedValueOnce({ entries: [], truncated: false });

      const res = await app.request(`${fileUrl}?path=missing/x.txt`);

      expect(res.status).toBe(404);
      expect(fsList.mock.calls[1][1]).toEqual({ glob: "missing" });
    });

    it("fails rather than 404s when listing an existing directory fails", async () => {
      mockAccess();
      fsList
        .mockRejectedValueOnce(new Error("fs.list: timed out"))
        .mockResolvedValueOnce(listing("out", 0, "dir"));

      const res = await app.request(`${fileUrl}?path=out/x.txt`);

      expect(res.status).toBe(500);
      expect(fsReadBytes).not.toHaveBeenCalled();
    });

    it("answers 404 when the Workspace has no Sandbox", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await app.request(`${fileUrl}?path=a.txt`);
      expect(res.status).toBe(404);
    });

    it("answers 501 when the backend cannot read bytes", async () => {
      mockAccess(BARE_BACKEND);

      const res = await app.request(`${fileUrl}?path=a.txt`);

      expect(res.status).toBe(501);
      expect(await res.json()).toEqual({
        error: "This Sandbox backend doesn't support file transfer",
      });
    });

    it.each([["/etc/passwd"], [""]])(
      "rejects the path %j with 400",
      async (path) => {
        mockAccess();
        const res = await app.request(
          `${fileUrl}?path=${encodeURIComponent(path)}`,
        );
        expect(res.status).toBe(400);
      },
    );

    // ADR-0027: `..` grants nothing a Workspace user can't already do.
    it("does not reject `..`", async () => {
      mockAccess();
      fsList.mockResolvedValueOnce(listing("x.txt", 1));
      fsReadBytes.mockResolvedValueOnce(new Uint8Array([1]));

      const res = await app.request(`${fileUrl}?path=../x.txt`);

      expect(res.status).toBe(200);
      expect(fsReadBytes).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ path: "../x.txt" }),
        expect.anything(),
      );
    });
  });

  describe("PUT /file (upload)", () => {
    const upload = (
      path: string,
      body: Uint8Array<ArrayBuffer>,
      {
        overwrite = false,
        headers = {},
      }: { overwrite?: boolean; headers?: Record<string, string> } = {},
    ) =>
      app.request(
        `${fileUrl}?path=${encodeURIComponent(path)}${overwrite ? "&overwrite=true" : ""}`,
        { method: "PUT", body, headers },
      );

    it("writes the raw bytes when the path is free", async () => {
      mockAccess();
      fsList.mockResolvedValueOnce({ entries: [], truncated: false });
      const bytes = new Uint8Array([0, 1, 2, 0xff, 0xfe]);

      const res = await upload("in/data.bin", bytes);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "File uploaded" });
      expect(fsList).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ path: "in" }),
        expect.anything(),
      );
      expect(fsWriteBytes).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: "ws-1" }),
        { path: "in/data.bin", bytes },
        expect.objectContaining({
          signal: expect.any(AbortSignal) as AbortSignal,
        }),
      );
    });

    it("probes the workspace root for a top-level path", async () => {
      mockAccess();
      fsList.mockResolvedValueOnce({ entries: [], truncated: false });

      await upload("data.bin", new Uint8Array([1]));

      expect(fsList.mock.calls[0][1]).not.toHaveProperty("path");
    });

    it("writes when the parent directory does not exist yet", async () => {
      mockAccess();
      fsList
        .mockRejectedValueOnce(new Error("fs.list: No such file"))
        .mockRejectedValueOnce(new Error("fs.list: No such file"))
        .mockResolvedValueOnce({ entries: [], truncated: false });

      const res = await upload("new/dir/data.bin", new Uint8Array([1]));

      expect(res.status).toBe(200);
      expect(fsWriteBytes).toHaveBeenCalled();
    });

    it("fails without writing when the probe fails on an existing directory", async () => {
      mockAccess();
      fsList
        .mockRejectedValueOnce(new Error("fs.list: timed out"))
        .mockResolvedValueOnce(listing("in", 0, "dir"));

      const res = await upload("in/data.bin", new Uint8Array([1]));

      expect(res.status).toBe(500);
      expect(fsWriteBytes).not.toHaveBeenCalled();
    });

    it("answers 409 without writing when the path is taken", async () => {
      mockAccess();
      fsList.mockResolvedValueOnce(listing("data.bin", 3));

      const res = await upload("in/data.bin", new Uint8Array([1]));

      expect(res.status).toBe(409);
      expect(fsWriteBytes).not.toHaveBeenCalled();
    });

    it("overwrites without probing when the overwrite flag is set", async () => {
      mockAccess();

      const res = await upload("in/data.bin", new Uint8Array([1]), {
        overwrite: true,
      });

      expect(res.status).toBe(200);
      expect(fsList).not.toHaveBeenCalled();
      expect(fsWriteBytes).toHaveBeenCalled();
    });

    it("accepts a body of exactly the bound", async () => {
      mockAccess();

      const res = await upload(
        "big.bin",
        new Uint8Array(SANDBOX_TRANSFER_MAX_BYTES),
        { overwrite: true },
      );

      expect(res.status).toBe(200);
      expect(
        (fsWriteBytes.mock.calls[0][1] as { bytes: Uint8Array }).bytes
          .byteLength,
      ).toBe(SANDBOX_TRANSFER_MAX_BYTES);
    });

    it("answers 413 for a body one byte over the bound", async () => {
      mockAccess();

      const res = await upload(
        "big.bin",
        new Uint8Array(SANDBOX_TRANSFER_MAX_BYTES + 1),
        { overwrite: true },
      );

      expect(res.status).toBe(413);
      expect(fsWriteBytes).not.toHaveBeenCalled();
    });

    it("answers 413 early on a declared Content-Length over the bound", async () => {
      mockAccess();

      const res = await upload("big.bin", new Uint8Array(1), {
        overwrite: true,
        headers: { "Content-Length": String(SANDBOX_TRANSFER_MAX_BYTES + 1) },
      });

      expect(res.status).toBe(413);
      expect(fsWriteBytes).not.toHaveBeenCalled();
    });

    it("answers 501 when the backend cannot write bytes", async () => {
      mockAccess(BARE_BACKEND);

      const res = await upload("a.bin", new Uint8Array([1]));

      expect(res.status).toBe(501);
      expect(fsList).not.toHaveBeenCalled();
    });

    it("answers 404 when the Workspace has no Sandbox", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await upload("a.bin", new Uint8Array([1]));
      expect(res.status).toBe(404);
    });
  });

  describe("access", () => {
    // Refused exactly as GET / refuses them.
    it.each([
      [
        "a User from another Organization",
        () => mockDb.limit.mockResolvedValueOnce([]),
      ],
      [
        "a non-owner, non-admin member",
        () => {
          mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
          mockDb.limit.mockResolvedValueOnce([
            { ownerId: "user-2", organizationId: "org-1" },
          ]);
        },
      ],
    ])("refuses %s", async (_, arrange) => {
      const statusOf = async (url: string, init?: RequestInit) => {
        resetMockDb();
        mockDb.where.mockReturnValue(mockDb);
        mockSession();
        arrange();
        return (await app.request(url, init)).status;
      };

      const expected = await statusOf(
        `/organizations/org-1/workspaces/ws-1/sandbox`,
      );
      expect(expected).toBeGreaterThanOrEqual(400);
      expect(await statusOf(`${fileUrl}?path=a.txt`)).toBe(expected);
      expect(
        await statusOf(`${fileUrl}?path=a.txt&overwrite=true`, {
          method: "PUT",
          body: new Uint8Array([1]),
        }),
      ).toBe(expected);
      expect(fsReadBytes).not.toHaveBeenCalled();
      expect(fsWriteBytes).not.toHaveBeenCalled();
    });
  });
});
