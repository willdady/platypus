import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migratedPglite } from "../db/migrated-pglite.test-fixtures.ts";

/**
 * Deleting a User's Workspaces, run for real against an in-process Postgres
 * built from the shipped migrations, then the User row itself: nothing the
 * Workspaces held is left behind. Only the cleanup outside the database
 * (Sandboxes, stored files) is stubbed.
 */
const { holder, mockPrepare, mockCleanUp } = vi.hoisted(() => {
  const holder: { db?: ReturnType<typeof drizzle> } = {};
  const mockCleanUp = vi.fn();
  return {
    holder,
    mockCleanUp,
    mockPrepare: vi.fn((_scope: { orgId: string; workspaceId: string }) =>
      Promise.resolve(mockCleanUp),
    ),
  };
});
vi.mock("../index.ts", () => ({
  get db() {
    return holder.db;
  },
}));
vi.mock("./workspace-delete.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./workspace-delete.ts")>()),
  prepareWorkspaceCleanup: mockPrepare,
}));

const { deleteOwnedWorkspaces } = await import("./user-delete.ts");

let pg: PGlite;
beforeEach(async () => {
  vi.clearAllMocks();
  pg = await migratedPglite();
  holder.db = drizzle(pg);
  await pg.exec(`
    INSERT INTO "user" ("id", "name", "email", "email_verified", "created_at", "updated_at")
      VALUES ('u1', 'Jane', 'jane@example.com', true, now(), now()),
             ('u2', 'John', 'john@example.com', true, now(), now());
    INSERT INTO "organization" ("id", "name") VALUES ('org-1', 'Acme'), ('org-2', 'Other');
    INSERT INTO "workspace" ("id", "organization_id", "owner_id", "name")
      VALUES ('ws-1', 'org-1', 'u1', 'Support'), ('ws-2', 'org-2', 'u1', 'Sales'),
             ('ws-3', 'org-1', 'u2', 'Kept');
    INSERT INTO "provider" ("id", "organization_id", "workspace_id", "name", "provider_type", "api_key", "task_model_id", "memory_extraction_model_id", "modelIds")
      VALUES ('shared-p', 'org-1', NULL, 'P', 'openai', 'k', 'm', 'm', '[]'),
             ('ws-1-p', NULL, 'ws-1', 'P', 'openai', 'k', 'm', 'm', '[]'),
             ('ws-2-p', NULL, 'ws-2', 'P', 'openai', 'k', 'm', 'm', '[]'),
             ('ws-3-p', NULL, 'ws-3', 'P', 'openai', 'k', 'm', 'm', '[]');
    INSERT INTO "agent" ("id", "organization_id", "workspace_id", "provider_id", "name", "description", "model_id")
      VALUES ('ws-1-a', NULL, 'ws-1', 'ws-1-p', 'Own', 'Helps', 'm'),
             ('ws-1-shared', NULL, 'ws-1', 'shared-p', 'Shared', 'Helps', 'm'),
             ('ws-2-a', NULL, 'ws-2', 'ws-2-p', 'Own', 'Helps', 'm'),
             ('ws-3-a', NULL, 'ws-3', 'ws-3-p', 'Own', 'Helps', 'm');
    INSERT INTO "trigger" ("id", "workspace_id", "agent_id", "type", "name", "instruction", "config")
      VALUES ('t1', 'ws-1', 'ws-1-a', 'cron', 'Nightly', 'Go', '{}');
  `);
}, 60_000);
afterEach(() => pg.close());

const ids = async (table: string) =>
  (
    await pg.query<{ id: string }>(`SELECT "id" FROM "${table}" ORDER BY 1`)
  ).rows.map((r) => r.id);

describe("deleteOwnedWorkspaces", () => {
  it("deletes every Workspace the User owns, with its Providers, then runs each Workspace's cleanup", async () => {
    await deleteOwnedWorkspaces("u1");
    await pg.exec(`DELETE FROM "user" WHERE "id" = 'u1'`);

    expect(await ids("workspace")).toEqual(["ws-3"]);
    expect(await ids("provider")).toEqual(["shared-p", "ws-3-p"]);
    expect(await ids("agent")).toEqual(["ws-3-a"]);
    expect(await ids("trigger")).toEqual([]);
    expect(mockPrepare.mock.calls.map(([scope]) => scope)).toEqual(
      expect.arrayContaining([
        { orgId: "org-1", workspaceId: "ws-1" },
        { orgId: "org-2", workspaceId: "ws-2" },
      ]),
    );
    expect(mockPrepare).toHaveBeenCalledTimes(2);
    expect(mockCleanUp).toHaveBeenCalledTimes(2);
  });
});
