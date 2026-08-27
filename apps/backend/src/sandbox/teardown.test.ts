import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { loadedPluginsFixture, mockDb, resetMockDb } from "../test-utils.ts";

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { destroySandboxRow, destroyWorkspaceSandboxes } from "./teardown.ts";
import { clearSandboxBackends, registerSandboxBackend } from "./index.ts";
import type { SandboxBackend } from "./types.ts";
import { setLoadedPlugins } from "../plugins/registry.ts";
import { logger } from "../logger.ts";
import {
  sandbox as sandboxTable,
  sandboxTeardownFailure as sandboxTeardownFailureTable,
} from "../db/schema.ts";

type SandboxRow = typeof sandboxTable.$inferSelect;

const workspaceId = "ws-1";
const BACKEND = "test-teardown";

const destroy = vi.fn<SandboxBackend["destroy"]>(() => Promise.resolve());
const create = vi.fn();

const stubBackend = (): SandboxBackend => ({
  shellExec: () =>
    Promise.resolve({
      stdout: "",
      stderr: "",
      exitCode: 0,
      truncated: false,
      durationMs: 0,
    }),
  fsRead: () =>
    Promise.resolve({ content: "", lineCount: 0, truncated: false }),
  fsWrite: () => Promise.resolve({ bytesWritten: 0 }),
  fsEdit: () => Promise.resolve({ replacements: 1 }),
  fsList: () => Promise.resolve({ entries: [], truncated: false }),
  destroy,
});

/**
 * Registers a backend against the real registry. Schemas default to shapes the
 * fixture row satisfies; a test that exercises adapter validation passes its
 * own.
 */
const registerBackend = ({
  backend = BACKEND,
  configSchema = z.object({ image: z.string() }),
  credentialsSchema = z.object({ token: z.string() }),
}: {
  backend?: string;
  configSchema?: z.ZodType<unknown>;
  credentialsSchema?: z.ZodType<unknown>;
} = {}) => {
  registerSandboxBackend({
    backend,
    name: `Test ${backend}`,
    configSchema,
    credentialsSchema,
    create: create.mockImplementation(() => stubBackend()),
  });
};

const makeRow = (over: Partial<SandboxRow> = {}): SandboxRow => ({
  id: "sb-1",
  workspaceId,
  name: "Sandbox",
  backend: BACKEND,
  config: { image: "node:24" },
  credentials: { token: "secret" },
  adminEnv: {},
  userEnv: {},
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  resetMockDb();
  clearSandboxBackends();
  setLoadedPlugins(loadedPluginsFixture());
  destroy.mockResolvedValue(undefined);
});

describe("destroySandboxRow", () => {
  it("throws when the row's backend is not registered", async () => {
    await expect(
      destroySandboxRow(makeRow({ backend: "ghost" })),
    ).rejects.toThrow(
      "Sandbox backend 'ghost' is not registered; cannot destroy",
    );
  });

  it("throws when the stored config fails adapter validation", async () => {
    registerBackend({ configSchema: z.object({ image: z.string() }) });

    await expect(
      destroySandboxRow(makeRow({ config: { image: 42 } })),
    ).rejects.toThrow(/Sandbox config failed adapter validation/);
    expect(create).not.toHaveBeenCalled();
  });

  it("throws when the stored credentials fail adapter validation", async () => {
    registerBackend({ credentialsSchema: z.object({ token: z.string() }) });

    await expect(
      destroySandboxRow(makeRow({ credentials: {} })),
    ).rejects.toThrow(/Sandbox credentials failed adapter validation/);
    expect(create).not.toHaveBeenCalled();
  });

  it("builds the adapter from the parsed config and destroys the row's workspace", async () => {
    registerBackend();

    await destroySandboxRow(makeRow());

    expect(create).toHaveBeenCalledWith(
      { image: "node:24" },
      { token: "secret" },
    );
    // Teardown is not a user-initiated request, so only the workspace is known.
    expect(destroy).toHaveBeenCalledWith({
      orgId: "",
      workspaceId,
      userId: "",
    });
  });

  it("validates a null config and credentials as empty objects", async () => {
    registerBackend({
      configSchema: z.object({}).strict(),
      credentialsSchema: z.object({}).strict(),
    });

    await destroySandboxRow(
      makeRow({ config: null as never, credentials: null as never }),
    );

    expect(create).toHaveBeenCalledWith({}, {});
  });

  it("propagates the adapter's destroy() rejection", async () => {
    registerBackend();
    destroy.mockRejectedValueOnce(new Error("API returned 500"));

    await expect(destroySandboxRow(makeRow())).rejects.toThrow(
      "API returned 500",
    );
  });
});

describe("destroyWorkspaceSandboxes", () => {
  it("does nothing when the workspace has no sandboxes", async () => {
    mockDb.where.mockResolvedValueOnce([]);

    await destroyWorkspaceSandboxes(workspaceId);

    expect(destroy).not.toHaveBeenCalled();
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("destroys every row and records nothing when all succeed", async () => {
    registerBackend();
    mockDb.where.mockResolvedValueOnce([
      makeRow({ id: "sb-1" }),
      makeRow({ id: "sb-2" }),
    ]);

    await destroyWorkspaceSandboxes(workspaceId);

    expect(destroy).toHaveBeenCalledTimes(2);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("records a ledger entry when destroy() fails", async () => {
    registerBackend();
    destroy.mockRejectedValueOnce(new Error("droplet already gone"));
    mockDb.where.mockResolvedValueOnce([makeRow()]);

    await destroyWorkspaceSandboxes(workspaceId);

    expect(mockDb.insert).toHaveBeenCalledWith(sandboxTeardownFailureTable);
    expect(mockDb.values).toHaveBeenCalledWith({
      id: expect.any(String) as unknown,
      workspaceId,
      backend: BACKEND,
      config: { image: "node:24" },
      error: "droplet already gone",
    });
  });

  it("stringifies a non-Error rejection into the ledger", async () => {
    registerBackend();
    destroy.mockRejectedValueOnce("socket hang up");
    mockDb.where.mockResolvedValueOnce([makeRow()]);

    await destroyWorkspaceSandboxes(workspaceId);

    expect(mockDb.values).toHaveBeenCalledWith(
      expect.objectContaining({ error: "socket hang up" }),
    );
  });

  it("records an empty config when the row has none", async () => {
    registerBackend({
      configSchema: z.object({}).strict(),
      credentialsSchema: z.object({}).strict(),
    });
    destroy.mockRejectedValueOnce(new Error("nope"));
    mockDb.where.mockResolvedValueOnce([
      makeRow({ config: null as never, credentials: null as never }),
    ]);

    await destroyWorkspaceSandboxes(workspaceId);

    expect(mockDb.values).toHaveBeenCalledWith(
      expect.objectContaining({ config: {} }),
    );
  });

  it("names the owning plugin in the warning", async () => {
    registerBackend();
    setLoadedPlugins(
      loadedPluginsFixture([], {
        sandboxBackends: new Map([[BACKEND, "docker"]]),
      }),
    );
    destroy.mockRejectedValueOnce(new Error("boom"));
    mockDb.where.mockResolvedValueOnce([makeRow()]);

    await destroyWorkspaceSandboxes(workspaceId);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        sandboxId: "sb-1",
        backend: BACKEND,
        plugin: "docker",
      }),
      expect.stringContaining("Sandbox destroy() failed"),
    );
  });

  // An unregistered backend is one of the ways a cascade teardown fails, and it
  // is exactly the case where no plugin owns the id.
  it("logs a null plugin when the backend belongs to no loaded plugin", async () => {
    mockDb.where.mockResolvedValueOnce([makeRow({ backend: "orphaned" })]);

    await destroyWorkspaceSandboxes(workspaceId);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ backend: "orphaned", plugin: null }),
      expect.any(String),
    );
    expect(mockDb.values).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "orphaned",
        error: expect.stringContaining("is not registered") as unknown,
      }),
    );
  });

  it("tears down the sibling row when one fails, and does not throw", async () => {
    registerBackend();
    destroy.mockRejectedValueOnce(new Error("first one failed"));
    mockDb.where.mockResolvedValueOnce([
      makeRow({ id: "sb-1" }),
      makeRow({ id: "sb-2" }),
    ]);

    await expect(
      destroyWorkspaceSandboxes(workspaceId),
    ).resolves.toBeUndefined();

    expect(destroy).toHaveBeenCalledTimes(2);
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
  });

  // The ledger row is what an Operator reconciles from, so when the insert
  // itself fails the error line is the only remaining record.
  it("logs an error when the ledger insert fails, and still resolves", async () => {
    registerBackend();
    destroy.mockRejectedValueOnce(new Error("boom"));
    mockDb.where.mockResolvedValueOnce([makeRow()]);
    mockDb.values.mockRejectedValueOnce(new Error("ledger table is gone"));

    await expect(
      destroyWorkspaceSandboxes(workspaceId),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        sandboxId: "sb-1",
        backend: BACKEND,
        err: expect.any(Error) as unknown,
      }),
      "Failed to record sandbox teardown failure",
    );
  });
});
