import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { migratedPglite } from "./migrated-pglite.test-fixtures.ts";

/**
 * A Pinned Agent's row goes with its Agent and with its Workspace, by the
 * foreign keys the shipped migrations create, so neither delete leaves an
 * orphaned pin.
 */
let pg: PGlite;
beforeEach(async () => {
  pg = await migratedPglite();
  await pg.exec(`
    INSERT INTO "user" ("id", "name", "email", "email_verified", "created_at", "updated_at")
      VALUES ('u1', 'Jane', 'jane@example.com', true, now(), now());
    INSERT INTO "organization" ("id", "name") VALUES ('org-1', 'Acme');
    INSERT INTO "workspace" ("id", "organization_id", "owner_id", "name")
      VALUES ('ws-1', 'org-1', 'u1', 'Support'), ('ws-2', 'org-1', 'u1', 'Sales');
    INSERT INTO "provider" ("id", "organization_id", "name", "provider_type", "api_key", "task_model_id", "memory_extraction_model_id", "modelIds")
      VALUES ('p1', 'org-1', 'P', 'openai', 'k', 'm', 'm', '[]');
    INSERT INTO "agent" ("id", "organization_id", "provider_id", "name", "description", "model_id")
      VALUES ('shared-1', 'org-1', 'p1', 'Helper', 'Helps', 'm');
    INSERT INTO "workspace_agent_pin" ("workspace_id", "agent_id")
      VALUES ('ws-1', 'shared-1'), ('ws-2', 'shared-1');
  `);
}, 60_000);
afterEach(() => pg.close());

const pins = async () =>
  (
    await pg.query<{ workspace_id: string }>(
      `SELECT "workspace_id" FROM "workspace_agent_pin" ORDER BY 1`,
    )
  ).rows.map((r) => r.workspace_id);

describe("workspace_agent_pin foreign keys", () => {
  it("refuse a second pin of the same Agent in one Workspace", async () => {
    await expect(
      pg.exec(
        `INSERT INTO "workspace_agent_pin" ("workspace_id", "agent_id") VALUES ('ws-1', 'shared-1')`,
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it("delete a Workspace's pins with the Workspace", async () => {
    await pg.exec(`DELETE FROM "workspace" WHERE "id" = 'ws-1'`);

    expect(await pins()).toEqual(["ws-2"]);
  });

  it("delete an Agent's pins in every Workspace with the Agent", async () => {
    await pg.exec(`DELETE FROM "agent" WHERE "id" = 'shared-1'`);

    expect(await pins()).toEqual([]);
  });
});
