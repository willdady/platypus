import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  applyMigration,
  migratedPglite,
} from "./migrated-pglite.test-fixtures.ts";

/**
 * The schedules→triggers rename left `schedule` in stored `agent.tool_set_ids`
 * (#1380); the migration rewrites it to `triggers` in place, without
 * duplicating it.
 */
const MIGRATION = "0086_rename_schedule_tool_set";

const seeded: Record<string, string[]> = {
  stale: ["memory", "schedule", "a"],
  both: ["memory", "schedule", "triggers"],
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
  it("rewrites schedule to triggers in place", () => {
    expect(after.stale).toEqual(["memory", "triggers", "a"]);
  });

  it("leaves one triggers entry when both were granted", () => {
    expect(after.both).toEqual(["memory", "triggers"]);
  });

  it("leaves Agents without schedule untouched", () => {
    expect(after.untouched).toEqual(seeded.untouched);
    expect(after.empty).toEqual([]);
  });
});
