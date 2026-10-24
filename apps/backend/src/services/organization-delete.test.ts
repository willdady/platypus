import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migratedPglite } from "../db/migrated-pglite.test-fixtures.ts";
import type { Tx } from "../index.ts";
import { deleteOrganizationRows } from "./organization-delete.ts";

/**
 * Deleting an Organization's rows, run for real against an in-process Postgres
 * built from the shipped migrations, so the delete rests on the foreign keys
 * production actually has: everything under the Organization goes, whichever
 * scope its Agents and Providers live in.
 */
let pg: PGlite;
beforeEach(async () => {
  pg = await migratedPglite();
  await pg.exec(`
    INSERT INTO "user" ("id", "name", "email", "email_verified", "created_at", "updated_at")
      VALUES ('u1', 'Jane', 'jane@example.com', true, now(), now());
    INSERT INTO "organization" ("id", "name") VALUES ('org-1', 'Acme'), ('org-2', 'Other');
    INSERT INTO "workspace" ("id", "organization_id", "owner_id", "name")
      VALUES ('ws-1', 'org-1', 'u1', 'Support'), ('ws-2', 'org-2', 'u1', 'Sales');
    INSERT INTO "provider" ("id", "organization_id", "name", "provider_type", "api_key", "task_model_id", "memory_extraction_model_id", "modelIds")
      VALUES ('shared-p', 'org-1', 'P', 'openai', 'k', 'm', 'm', '[]'),
             ('other-p', 'org-2', 'P', 'openai', 'k', 'm', 'm', '[]');
    INSERT INTO "provider" ("id", "workspace_id", "name", "provider_type", "api_key", "task_model_id", "memory_extraction_model_id", "modelIds")
      VALUES ('ws-p', 'ws-1', 'P', 'openai', 'k', 'm', 'm', '[]');
    INSERT INTO "agent" ("id", "organization_id", "workspace_id", "provider_id", "name", "description", "model_id")
      VALUES ('shared-a', 'org-1', NULL, 'shared-p', 'Shared', 'Helps', 'm'),
             ('ws-a', NULL, 'ws-1', 'shared-p', 'Local', 'Helps', 'm'),
             ('ws-a2', NULL, 'ws-1', 'ws-p', 'Own', 'Helps', 'm'),
             ('other-a', NULL, 'ws-2', 'other-p', 'Other', 'Helps', 'm');
    INSERT INTO "trigger" ("id", "workspace_id", "agent_id", "type", "name", "instruction", "config")
      VALUES ('t-ws', 'ws-1', 'ws-a', 'cron', 'Nightly', 'Go', '{}'),
             ('t-shared', 'ws-1', 'shared-a', 'cron', 'Hourly', 'Go', '{}'),
             ('t-other', 'ws-2', 'other-a', 'cron', 'Daily', 'Go', '{}');
  `);
}, 60_000);
afterEach(() => pg.close());

const ids = async (table: string) =>
  (
    await pg.query<{ id: string }>(`SELECT "id" FROM "${table}" ORDER BY 1`)
  ).rows.map((r) => r.id);

describe("deleteOrganizationRows", () => {
  it("deletes an Organization whose Workspace Agent and Org Agent, each with a Trigger, use a Shared Provider, and its Workspace Providers", async () => {
    await drizzle(pg).transaction((tx) =>
      deleteOrganizationRows(tx as unknown as Tx, "org-1"),
    );

    expect(await ids("organization")).toEqual(["org-2"]);
    expect(await ids("workspace")).toEqual(["ws-2"]);
    expect(await ids("provider")).toEqual(["other-p"]);
    expect(await ids("agent")).toEqual(["other-a"]);
    expect(await ids("trigger")).toEqual(["t-other"]);
  });

  it("deletes an Organization with no Workspaces", async () => {
    await pg.exec(`
      INSERT INTO "organization" ("id", "name") VALUES ('org-3', 'Empty');
    `);

    await drizzle(pg).transaction((tx) =>
      deleteOrganizationRows(tx as unknown as Tx, "org-3"),
    );

    expect(await ids("organization")).toEqual(["org-1", "org-2"]);
    expect(await ids("trigger")).toEqual(["t-other", "t-shared", "t-ws"]);
  });
});
