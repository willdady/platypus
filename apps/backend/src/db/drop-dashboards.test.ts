import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  applyMigration,
  migratedPglite,
} from "./migrated-pglite.test-fixtures.ts";

/**
 * Dashboards are removed in 4.0.0 (#1430): the migration drops their tables
 * and strips the retired `dashboards` Tool set from stored `agent.tool_set_ids`.
 */
const MIGRATION = "0099_drop_dashboards";

const seeded: Record<string, string[]> = {
  granted: ["memory", "dashboards", "a"],
  only: ["dashboards"],
  untouched: ["memory", "triggers"],
  empty: [],
};

let pg: PGlite;
let after: Record<string, string[]>;
beforeAll(async () => {
  pg = await migratedPglite(MIGRATION);
  await pg.exec(`
    INSERT INTO "user" ("id", "name", "email", "email_verified", "created_at", "updated_at")
      VALUES ('u', 'U', 'u@example.com', true, now(), now());
    INSERT INTO "organization" ("id", "name") VALUES ('o', 'O');
    INSERT INTO "workspace" ("id", "organization_id", "owner_id", "name") VALUES ('w', 'o', 'u', 'W');
    INSERT INTO "provider" ("id", "workspace_id", "name", "provider_type", "api_key", "task_model_id", "memory_extraction_model_id", "modelIds")
      VALUES ('p', 'w', 'P', 'openai', 'k', 'm', 'm', '[]');
    INSERT INTO "dashboard" ("id", "workspace_id", "name") VALUES ('d', 'w', 'D');
    INSERT INTO "widget" ("id", "dashboard_id", "type", "title") VALUES ('x', 'd', 'metric', 'X');
  `);
  for (const [id, ids] of Object.entries(seeded)) {
    await pg.query(
      `INSERT INTO "agent" ("id", "workspace_id", "provider_id", "name", "description", "model_id", "tool_set_ids")
         VALUES ($1, 'w', 'p', $1, '', 'm', $2)`,
      [id, JSON.stringify(ids)],
    );
  }
  await applyMigration(pg, MIGRATION);
  const { rows } = await pg.query<{ id: string; tool_set_ids: string[] }>(
    `SELECT "id", "tool_set_ids" FROM "agent"`,
  );
  after = Object.fromEntries(rows.map((r) => [r.id, r.tool_set_ids]));
}, 60_000);
afterAll(() => pg.close());

describe(MIGRATION, () => {
  it("drops the dashboard and widget tables", async () => {
    const { rows } = await pg.query(
      `SELECT "table_name" FROM information_schema.tables
         WHERE "table_name" IN ('dashboard', 'widget')`,
    );
    expect(rows).toEqual([]);
  });

  it("strips dashboards from every Agent, keeping the rest in order", () => {
    expect(after.granted).toEqual(["memory", "a"]);
    expect(after.only).toEqual([]);
  });

  it("leaves Agents without dashboards untouched", () => {
    expect(after.untouched).toEqual(seeded.untouched);
    expect(after.empty).toEqual([]);
  });
});
