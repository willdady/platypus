import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  applyMigration,
  migratedPglite,
} from "./migrated-pglite.test-fixtures.ts";

/**
 * Column names become unique per Board (#1620): the migration first renames
 * the duplicates already stored, keeping the earliest column's name and
 * suffixing the later ones, so the constraint can be added and no name is lost.
 */
const TAG = "0092_chat_indexes_kanban_column_name";
/** A name at the 100-character limit a column name may have. */
const LONG = "L".repeat(100);

let pg: PGlite;
beforeAll(async () => {
  pg = await migratedPglite(TAG);
  await pg.exec(`
    INSERT INTO "user" ("id", "name", "email", "email_verified", "created_at", "updated_at")
      VALUES ('u1', 'Jane', 'jane@example.com', true, now(), now());
    INSERT INTO "organization" ("id", "name") VALUES ('org-1', 'Acme');
    INSERT INTO "workspace" ("id", "organization_id", "owner_id", "name")
      VALUES ('ws-1', 'org-1', 'u1', 'Support');
    INSERT INTO "kanban_board" ("id", "workspace_id", "name") VALUES
      ('board-1', 'ws-1', 'Work'),
      ('board-2', 'ws-1', 'Home');
    INSERT INTO "kanban_column" ("id", "board_id", "name", "position", "created_at") VALUES
      ('c-done-3', 'board-1', 'Done', 3, '2026-01-03'),
      ('c-done-1', 'board-1', 'Done', 1, '2026-01-01'),
      ('c-done-2', 'board-1', 'Done', 2, '2026-01-02'),
      ('c-taken', 'board-1', 'Done (2)', 4, '2026-01-04'),
      ('c-todo', 'board-1', 'To do', 5, '2026-01-05'),
      ('c-home-done', 'board-2', 'Done', 1, '2026-01-01'),
      ('c-long-1', 'board-2', repeat('L', 100), 2, '2026-01-01'),
      ('c-long-2', 'board-2', repeat('L', 100), 3, '2026-01-02');
  `);
  await applyMigration(pg, TAG);
}, 60_000);
afterAll(() => pg.close());

const names = async () =>
  Object.fromEntries(
    (
      await pg.query<{ id: string; name: string }>(
        `SELECT "id", "name" FROM "kanban_column"`,
      )
    ).rows.map((r) => [r.id, r.name]),
  );

describe("0092 Kanban column name dedupe", () => {
  it("keeps the earliest column's name and suffixes the later ones past any name already taken", async () => {
    expect(await names()).toEqual({
      "c-done-1": "Done",
      "c-done-2": "Done (3)",
      "c-done-3": "Done (4)",
      "c-taken": "Done (2)",
      "c-todo": "To do",
      "c-home-done": "Done",
      "c-long-1": LONG,
      "c-long-2": `${LONG.slice(0, 96)} (2)`,
    });
  });

  it("shortens a name at the length limit to make room for its suffix", async () => {
    expect((await names())["c-long-2"]).toHaveLength(100);
  });

  it("then refuses a duplicate name on a Board", async () => {
    await expect(
      pg.exec(`
        INSERT INTO "kanban_column" ("id", "board_id", "name", "position")
          VALUES ('c-again', 'board-1', 'To do', 6);
      `),
    ).rejects.toThrow(/unique_kanban_column_name_board/);
  });
});
