import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";
import {
  insertTimestamps,
  loadedPluginsFixture,
  mockSession,
  resetMockDb,
  seedDb,
  type FakeDb,
  type Row,
  type Store,
} from "../test-utils.ts";
import type { FakeDbOptions } from "../fake-db.ts";
import app from "../server.ts";
import {
  registerSandboxBackend,
  type SandboxBackend,
} from "../sandbox/index.ts";
import { SANDBOX_TRANSFER_MAX_BYTES } from "@platypuschat/plugin-sdk";
import { setLoadedPlugins } from "../plugins/registry.ts";
import { logger } from "../logger.ts";

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

const orgId = "org-1";
const workspaceId = "ws-1";
const baseUrl = `/organizations/${orgId}/workspaces/${workspaceId}/sandbox`;

const sandboxRow = (over: Row = {}): Row => ({
  id: "sbx-1",
  workspaceId,
  name: "Local Docker",
  backend: "docker",
  config: {},
  credentials: {},
  adminEnv: {},
  userEnv: {},
  ...insertTimestamps(),
  ...over,
});

const uniqueSandboxWorkspace = {
  name: "unique_sandbox_workspace_id",
  columns: ["workspaceId"],
};

// why: every world seeds an org-2 membership and workspace, so a lookup missing its scope fails
const world = (
  role: "admin" | "member" = "member",
  rows: Store = {},
  options: FakeDbOptions = {},
): FakeDb =>
  seedDb(
    {
      organization_member: [
        { id: "m2", userId: "user-1", organizationId: "org-2", role: "member" },
        { id: "m1", userId: "user-1", organizationId: orgId, role },
        { id: "m3", userId: "user-2", organizationId: "org-2", role: "admin" },
      ],
      workspace: [
        { id: workspaceId, organizationId: orgId, ownerId: "user-1" },
        { id: "ws-2", organizationId: orgId, ownerId: "user-2" },
        { id: "ws-other", organizationId: "org-2", ownerId: "user-2" },
      ],
      ...rows,
    },
    {
      unique: { sandbox: [uniqueSandboxWorkspace], ...options.unique },
      defaults: { sandbox: insertTimestamps(), ...options.defaults },
      ...(options.onQuery && { onQuery: options.onQuery }),
      ...(options.onInsert && { onInsert: options.onInsert }),
    },
  );

const FIELDS_BACKEND = "test-fields";
registerSandboxBackend({
  backend: FIELDS_BACKEND,
  name: "Test Fields",
  configSchema: z.object({ region: z.string().min(1) }).strict(),
  credentialsSchema: z.object({ apiToken: z.string().min(1) }).strict(),
  create: () => {
    throw new Error("not used in this test");
  },
});

describe("Sandbox Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

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
      const fake = world("admin");

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify(validBody),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).not.toHaveProperty("credentials");
      expect(body.hasCredentials).toBe(true);
      expect(body.id).toBe(fake.tables.sandbox[0].id);
      expect(body.backend).toBe("docker");
      expect(fake.tables.sandbox).toEqual([
        expect.objectContaining({
          id: body.id,
          workspaceId,
          name: "Local Docker",
          backend: "docker",
          config: { image: "debian:stable-slim" },
          credentials: { token: "secret-123" },
        }),
      ]);
    });

    it("returns 400 when credentials fail the backend's schema", async () => {
      mockSession();
      const fake = world("admin");

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          workspaceId,
          name: "Creds backend",
          backend: CREDS_BACKEND,
          config: {},
          credentials: {},
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: Array<{ path: Array<string | number>; message: string }>;
      };
      expect(body.error).toContainEqual(
        expect.objectContaining({ path: ["credentials", "privateKey"] }),
      );
      expect(fake.queries.filter((q) => q.kind === "insert")).toHaveLength(0);
    });

    it("stores a generated backend's required config and credentials", async () => {
      mockSession();
      const fake = world("admin");

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          workspaceId,
          name: "Cloud box",
          backend: FIELDS_BACKEND,
          config: { region: "eu" },
          credentials: { apiToken: "tok" },
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      expect(fake.tables.sandbox).toEqual([
        expect.objectContaining({
          backend: FIELDS_BACKEND,
          config: { region: "eu" },
          credentials: { apiToken: "tok" },
        }),
      ]);
    });

    it("returns 409 when a sandbox already exists for the workspace", async () => {
      mockSession();
      const fake = world("admin", { sandbox: [sandboxRow()] });

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify(validBody),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("Sandbox already configured for this workspace");
      expect(fake.tables.sandbox).toHaveLength(1);
      expect(fake.tables.sandbox[0]).toMatchObject({ id: "sbx-1" });
    });
  });

  describe("GET /", () => {
    // why: ws-2 has a Sandbox too, so a lookup that drops the workspace filter answers with it
    const boxes = (over: Row = {}) => [
      sandboxRow({ id: "sbx-other", workspaceId: "ws-2", name: "Other box" }),
      sandboxRow(over),
    ];

    it("returns the sandbox with credentials stripped", async () => {
      mockSession();
      world("member", {
        sandbox: boxes({ credentials: { token: "secret-123" } }),
      });

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).not.toHaveProperty("credentials");
      expect(body.id).toBe("sbx-1");
    });

    it.each([
      ["admin", { privateKey: "PRIVATE-KEY", passphrase: "PASSPHRASE" }, true],
      ["member", { privateKey: "PRIVATE-KEY", passphrase: "PASSPHRASE" }, true],
      ["admin", {}, false],
      ["member", {}, false],
    ] as const)(
      "tells a %s whether credentials are stored (%j → %s), never what they are",
      async (role, credentials, hasCredentials) => {
        mockSession();
        world(role, {
          sandbox: boxes({
            name: "SSH host",
            backend: "ssh",
            config: { host: "ssh.example.com", user: "platypus" },
            credentials,
          }),
        });

        const res = await app.request(baseUrl);
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(JSON.parse(text)).toMatchObject({ hasCredentials });
        expect(text).not.toMatch(
          /"credentials"|privateKey|passphrase|PRIVATE-KEY|PASSPHRASE/,
        );
      },
    );

    it.each([
      ["admin", { ADMIN_KEY: "secret" }],
      ["member", { ADMIN_KEY: "" }],
    ] as const)("shows a %s adminEnv as %j", async (role, adminEnv) => {
      mockSession();
      world(role, {
        sandbox: boxes({
          name: "SSH host",
          backend: "ssh",
          adminEnv: { ADMIN_KEY: "secret" },
        }),
      });

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ adminEnv });
    });

    it("returns 404 when no sandbox is configured", async () => {
      mockSession();
      world("member", {
        sandbox: [sandboxRow({ id: "sbx-other", workspaceId: "ws-2" })],
      });

      const res = await app.request(baseUrl);
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /", () => {
    const updatesOf = (fake: FakeDb) =>
      fake.queries.filter((q) => q.kind === "update");

    it("updates the sandbox when the backend is unchanged", async () => {
      mockSession();
      const fake = world("admin", { sandbox: [sandboxRow()] });

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
      expect(fake.tables.sandbox).toEqual([
        expect.objectContaining({
          id: "sbx-1",
          name: "Renamed",
          backend: "docker",
          credentials: { token: "rotated" },
        }),
      ]);
    });

    it("rejects an unknown query key", async () => {
      mockSession();
      const fake = world("admin", { sandbox: [sandboxRow()] });

      const res = await app.request(`${baseUrl}?foo=1`, {
        method: "PUT",
        body: JSON.stringify({
          name: "Renamed",
          backend: "docker",
          config: {},
          credentials: {},
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
      expect(updatesOf(fake)).toHaveLength(0);
      expect(fake.tables.sandbox[0]).toMatchObject({ name: "Local Docker" });
    });

    it("returns 502 when changing backend and the previous adapter's destroy() fails", async () => {
      mockSession();
      const fake = world("admin", {
        sandbox: [sandboxRow({ backend: "no-such-backend" })],
      });

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

      expect(res.status).toBe(502);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toMatch(/force=true/);
      expect(updatesOf(fake)).toHaveLength(0);
      expect(fake.tables.sandbox[0]).toMatchObject({
        backend: "no-such-backend",
      });
    });

    it("skips destroy() and switches backend when ?force=true", async () => {
      mockSession();
      const fake = world("admin", {
        sandbox: [sandboxRow({ backend: "no-such-backend" })],
      });

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
      expect(fake.tables.sandbox[0]).toMatchObject({
        name: "Switched",
        backend: "another-backend",
      });
    });

    it("attributes the force-change leak warning to the outgoing backend's plugin", async () => {
      mockSession();
      const fake = world("admin", {
        sandbox: [sandboxRow({ backend: ANNOTATED_BACKEND })],
      });
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
      expect(warn).not.toHaveBeenCalledWith(
        expect.objectContaining({ plugin: "@platypus/incoming" }),
        expect.anything(),
      );
      expect(fake.tables.sandbox[0]).toMatchObject({ backend: CREDS_BACKEND });
      warn.mockRestore();
    });

    it("returns 404 when no sandbox is configured", async () => {
      mockSession();
      const fake = world("admin", {
        sandbox: [sandboxRow({ id: "sbx-other", workspaceId: "ws-2" })],
      });

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
      expect(updatesOf(fake)).toHaveLength(0);
    });
  });

  describe("DELETE /", () => {
    const deletesOf = (fake: FakeDb) =>
      fake.queries.filter((q) => q.kind === "delete");

    it("force-deletes the sandbox without invoking destroy()", async () => {
      mockSession();
      const fake = world("admin", { sandbox: [sandboxRow()] });

      const res = await app.request(`${baseUrl}?force=true`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Sandbox deleted" });
      expect(fake.tables.sandbox).toHaveLength(0);
      expect(deletesOf(fake)).toEqual([{ kind: "delete", table: "sandbox" }]);
    });

    it("rejects an unknown query key", async () => {
      mockSession();
      const fake = world("admin", { sandbox: [sandboxRow()] });

      const res = await app.request(`${baseUrl}?foo=1`, { method: "DELETE" });

      expect(res.status).toBe(400);
      expect(deletesOf(fake)).toHaveLength(0);
      expect(fake.tables.sandbox).toHaveLength(1);
    });

    it("names the owning plugin on the force-delete leak warning", async () => {
      mockSession();
      world("admin", { sandbox: [sandboxRow({ backend: ANNOTATED_BACKEND })] });
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
      mockSession();
      world("admin", {
        sandbox: [sandboxRow({ backend: "no-such-backend" })],
      });
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

    it("returns 502 when destroy() fails and preserves the row", async () => {
      mockSession();
      const fake = world("admin", {
        sandbox: [sandboxRow({ backend: "no-such-backend" })],
      });

      const res = await app.request(baseUrl, { method: "DELETE" });
      expect(res.status).toBe(502);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toMatch(/no-such-backend/);
      expect(body.error).toMatch(/force=true/);
      expect(deletesOf(fake)).toHaveLength(0);
      expect(fake.tables.sandbox).toEqual([
        expect.objectContaining({ id: "sbx-1", backend: "no-such-backend" }),
      ]);
    });

    it("returns 404 when no sandbox is configured", async () => {
      mockSession();
      world("admin", {
        sandbox: [sandboxRow({ id: "sbx-other", workspaceId: "ws-2" })],
      });

      const res = await app.request(baseUrl, { method: "DELETE" });
      expect(res.status).toBe(404);
    });
  });

  describe("authorization (ADR-0006)", () => {
    it("POST / returns 403 for a non-admin workspace owner", async () => {
      mockSession();
      const fake = world("member");

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify(validBody),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(403);
      expect(fake.queries.filter((q) => q.kind === "insert")).toHaveLength(0);
    });

    it("DELETE / returns 403 for a non-admin workspace owner", async () => {
      mockSession();
      const fake = world("member", { sandbox: [sandboxRow()] });

      const res = await app.request(baseUrl, { method: "DELETE" });
      expect(res.status).toBe(403);
      expect(fake.queries.filter((q) => q.kind === "delete")).toHaveLength(0);
      expect(fake.tables.sandbox).toHaveLength(1);
    });

    it("POST / rejects userEnv keys that collide with adminEnv (400)", async () => {
      mockSession();
      const fake = world("admin");

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
      expect(fake.queries.filter((q) => q.kind === "insert")).toHaveLength(0);
    });

    it("PUT / lets a non-admin owner change name and userEnv only", async () => {
      mockSession();
      const fake = world("member", {
        sandbox: [
          sandboxRow({
            name: "Old",
            config: { networks: ["shared"] },
            adminEnv: { ADMIN_KEY: "x" },
          }),
        ],
      });

      const res = await app.request(baseUrl, {
        method: "PUT",
        body: JSON.stringify({
          name: "New",
          backend: "evil-backend",
          userEnv: { MY_KEY: "y" },
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(200);
      expect(fake.tables.sandbox).toEqual([
        expect.objectContaining({
          name: "New",
          userEnv: { MY_KEY: "y" },
          backend: "docker",
          config: { networks: ["shared"] },
        }),
      ]);
    });

    it("PUT / rejects a non-admin owner's userEnv that collides with stored adminEnv (400)", async () => {
      mockSession();
      const fake = world("member", {
        sandbox: [
          sandboxRow({
            name: "Old",
            adminEnv: { ADMIN_KEY: "x" },
          }),
        ],
      });

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
      expect(fake.tables.sandbox[0]).toMatchObject({ userEnv: {} });
    });
  });

  describe("admin input validation", () => {
    const stored = sandboxRow({
      name: "Creds backend",
      backend: CREDS_BACKEND,
      adminEnv: { ADMIN_KEY: "x" },
    });

    const asAdmin = (existing?: Row): FakeDb => {
      mockSession();
      return world("admin", existing ? { sandbox: [existing] } : {});
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
        ["config"],
      ],
      [
        "PUT: config failing the backend's schema",
        "PUT",
        { config: { unexpected: true } },
        ["config"],
      ],
      [
        "PUT: credentials failing the backend's schema",
        "PUT",
        { config: {}, credentials: {} },
        ["credentials", "privateKey"],
      ],
    ] as const)("rejects %s (400)", async (_label, method, over, path) => {
      const fake = asAdmin(method === "PUT" ? stored : undefined);

      const res = await send(method, {
        ...(method === "POST" ? { workspaceId } : {}),
        name: "Creds backend",
        backend: CREDS_BACKEND,
        ...over,
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: Array<{ path: Array<string | number>; message: string }>;
      };
      expect(body.error).toContainEqual(
        expect.objectContaining({ path: [...path] }),
      );
      expect(
        fake.queries.filter((q) => q.kind === "insert" || q.kind === "update"),
      ).toHaveLength(0);
    });

    it("rejects a userEnv colliding with the stored adminEnv (400)", async () => {
      const fake = asAdmin(stored);

      const res = await send("PUT", {
        name: "Creds backend",
        backend: CREDS_BACKEND,
        config: {},
        userEnv: { ADMIN_KEY: "y" },
      });

      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(
        /ADMIN_KEY/,
      );
      expect(fake.queries.filter((q) => q.kind === "update")).toHaveLength(0);
    });

    it("stores a generated backend's updated config and credentials", async () => {
      const fake = asAdmin(
        sandboxRow({
          name: "Cloud box",
          backend: FIELDS_BACKEND,
          config: { region: "us" },
          credentials: { apiToken: "old" },
        }),
      );

      const res = await send("PUT", {
        name: "Cloud box",
        backend: FIELDS_BACKEND,
        config: { region: "eu" },
        credentials: { apiToken: "new" },
      });

      expect(res.status).toBe(200);
      expect(fake.tables.sandbox[0]).toMatchObject({
        config: { region: "eu" },
        credentials: { apiToken: "new" },
      });
    });
  });
});

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

  const fileUrl = `${baseUrl}/file`;

  const row = (backend = TRANSFER_BACKEND) =>
    sandboxRow({ name: "Box", backend });

  const mockAccess = (
    backend = TRANSFER_BACKEND,
    role: "admin" | "member" = "member",
  ) => {
    mockSession();
    // why: ws-2 has a Box too, so a lookup that drops the workspace filter opens it instead
    return world(role, {
      sandbox: [
        sandboxRow({
          id: "sbx-other",
          workspaceId: "ws-2",
          name: "Other box",
          backend,
        }),
        row(backend),
      ],
    });
  };

  const listing = (path: string, size: number, type = "file") => ({
    entries: [{ path, type, size }],
    truncated: false,
  });

  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
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
      world("member", { sandbox: [row(backend)] });

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
      fsList.mockImplementationOnce(() =>
        Promise.resolve(listing("page.html", bytes.length)),
      );
      fsReadBytes.mockImplementationOnce(() => Promise.resolve(bytes));

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
      fsList.mockImplementationOnce(() =>
        Promise.resolve(listing('ré"sumé.pdf', 1)),
      );
      fsReadBytes.mockImplementationOnce(() =>
        Promise.resolve(new Uint8Array([1])),
      );

      const res = await app.request(
        `${fileUrl}?path=${encodeURIComponent('ré"sumé.pdf')}`,
      );

      expect(res.headers.get("content-disposition")).toBe(
        `attachment; filename*=UTF-8''r%C3%A9%22sum%C3%A9.pdf`,
      );
    });

    it("serves a file of exactly the bound", async () => {
      mockAccess();
      fsList.mockImplementationOnce(() =>
        Promise.resolve(listing("big.bin", SANDBOX_TRANSFER_MAX_BYTES)),
      );
      fsReadBytes.mockImplementationOnce(() =>
        Promise.resolve(new Uint8Array(SANDBOX_TRANSFER_MAX_BYTES)),
      );

      const res = await app.request(`${fileUrl}?path=big.bin`);

      expect(res.status).toBe(200);
      expect((await res.arrayBuffer()).byteLength).toBe(
        SANDBOX_TRANSFER_MAX_BYTES,
      );
    });

    it("answers 413 for a file one byte over the bound, without reading it", async () => {
      mockAccess();
      fsList.mockImplementationOnce(() =>
        Promise.resolve(listing("big.bin", SANDBOX_TRANSFER_MAX_BYTES + 1)),
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
        .mockImplementationOnce(() =>
          Promise.reject(new Error("fs.list: No such file or directory")),
        )
        .mockImplementationOnce(() =>
          Promise.resolve({ entries: [], truncated: false }),
        );

      const res = await app.request(`${fileUrl}?path=missing/x.txt`);

      expect(res.status).toBe(404);
      expect(fsList.mock.calls[1][1]).toEqual({ glob: "missing" });
    });

    it("fails rather than 404s when listing an existing directory fails", async () => {
      mockAccess();
      fsList
        .mockImplementationOnce(() =>
          Promise.reject(new Error("fs.list: timed out")),
        )
        .mockImplementationOnce(() =>
          Promise.resolve(listing("out", 0, "dir")),
        );

      const res = await app.request(`${fileUrl}?path=out/x.txt`);

      expect(res.status).toBe(500);
      expect(fsReadBytes).not.toHaveBeenCalled();
    });

    it("answers 404 when the Workspace has no Sandbox", async () => {
      mockSession();
      world("member", {
        sandbox: [sandboxRow({ id: "sbx-other", workspaceId: "ws-2" })],
      });

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

    it("does not reject `..`", async () => {
      mockAccess();
      fsList.mockImplementationOnce(() => Promise.resolve(listing("x.txt", 1)));
      fsReadBytes.mockImplementationOnce(() =>
        Promise.resolve(new Uint8Array([1])),
      );

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
      fsList.mockImplementationOnce(() =>
        Promise.resolve({ entries: [], truncated: false }),
      );
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
      fsList.mockImplementationOnce(() =>
        Promise.resolve({ entries: [], truncated: false }),
      );

      await upload("data.bin", new Uint8Array([1]));

      expect(fsList.mock.calls[0][1]).not.toHaveProperty("path");
    });

    it("writes when the parent directory does not exist yet", async () => {
      mockAccess();
      fsList
        .mockImplementationOnce(() =>
          Promise.reject(new Error("fs.list: No such file")),
        )
        .mockImplementationOnce(() =>
          Promise.reject(new Error("fs.list: No such file")),
        )
        .mockImplementationOnce(() =>
          Promise.resolve({ entries: [], truncated: false }),
        );

      const res = await upload("new/dir/data.bin", new Uint8Array([1]));

      expect(res.status).toBe(200);
      expect(fsWriteBytes).toHaveBeenCalled();
    });

    it("fails without writing when the probe fails on an existing directory", async () => {
      mockAccess();
      fsList
        .mockImplementationOnce(() =>
          Promise.reject(new Error("fs.list: timed out")),
        )
        .mockImplementationOnce(() => Promise.resolve(listing("in", 0, "dir")));

      const res = await upload("in/data.bin", new Uint8Array([1]));

      expect(res.status).toBe(500);
      expect(fsWriteBytes).not.toHaveBeenCalled();
    });

    it("answers 409 without writing when the path is taken", async () => {
      mockAccess();
      fsList.mockImplementationOnce(() =>
        Promise.resolve(listing("data.bin", 3)),
      );

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
      world("member", {
        sandbox: [sandboxRow({ id: "sbx-other", workspaceId: "ws-2" })],
      });

      const res = await upload("a.bin", new Uint8Array([1]));
      expect(res.status).toBe(404);
    });
  });

  describe("access", () => {
    it.each([
      [
        "a User from another Organization",
        () =>
          world("member", {
            organization_member: [
              {
                id: "m-out",
                userId: "user-1",
                organizationId: "org-2",
                role: "admin",
              },
            ],
          }),
      ],
      [
        "a non-owner, non-admin member",
        () =>
          world("member", {
            workspace: [
              { id: workspaceId, organizationId: orgId, ownerId: "user-2" },
            ],
          }),
      ],
    ])("refuses %s", async (_, arrange) => {
      const statusOf = async (url: string, init?: RequestInit) => {
        resetMockDb();
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
