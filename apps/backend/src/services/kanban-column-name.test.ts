import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migratedPglite } from "../db/migrated-pglite.test-fixtures.ts";
import { ConflictError } from "../errors.ts";
import { mockNanoid } from "../test-setup.ts";

/**
 * Column names stay unique per Board under concurrent writes, against an
 * in-process Postgres built from the shipped migrations, so the database's own
 * constraint is what catches the write the in-app check let through.
 */
vi.mock("./event-dispatch.ts", () => ({ dispatchEvent: vi.fn() }));
// Two inserts in flight need two ids.
mockNanoid.mockImplementation(() => crypto.randomUUID());

const { createColumn, renameColumn } = await import("./kanban-column.ts");

let pg: PGlite;
let database: ReturnType<typeof drizzle>;
beforeAll(async () => {
  pg = await migratedPglite();
  database = drizzle(pg);
}, 60_000);
afterAll(() => pg.close());

const scope = { orgId: "org-1", workspaceId: "ws-1" };

beforeEach(async () => {
  await pg.exec(`
    DELETE FROM "organization";
    DELETE FROM "user";
    INSERT INTO "user" ("id", "name", "email", "email_verified", "created_at", "updated_at")
      VALUES ('u1', 'Jane', 'jane@example.com', true, now(), now());
    INSERT INTO "organization" ("id", "name") VALUES ('org-1', 'Acme');
    INSERT INTO "workspace" ("id", "organization_id", "owner_id", "name")
      VALUES ('ws-1', 'org-1', 'u1', 'Support');
    INSERT INTO "kanban_board" ("id", "workspace_id", "name") VALUES
      ('board-1', 'ws-1', 'Work'),
      ('board-2', 'ws-1', 'Home');
    INSERT INTO "kanban_column" ("id", "board_id", "name", "position") VALUES
      ('col-todo', 'board-1', 'To do', 1),
      ('col-doing', 'board-1', 'Doing', 2);
  `);
});

const columnNames = async (boardId: string) =>
  (
    await pg.query<{ name: string }>(
      `SELECT "name" FROM "kanban_column" WHERE "board_id" = $1 ORDER BY "name"`,
      [boardId],
    )
  ).rows.map((r) => r.name);

const CLASH = "A column with this name already exists on the board";

describe("column names on a Board", () => {
  it("lets one of two concurrent same-name creates through and refuses the other with a conflict", async () => {
    const results = await Promise.allSettled([
      createColumn(database as never, scope, "board-1", { name: "Done" }),
      createColumn(database as never, scope, "board-1", { name: "Done" }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const rejected = results.find(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    )!;
    expect(rejected.reason).toBeInstanceOf(ConflictError);
    expect((rejected.reason as ConflictError).message).toBe(CLASH);
    expect(await columnNames("board-1")).toEqual(["Doing", "Done", "To do"]);
  });

  it("refuses two concurrent renames onto the same name with a conflict", async () => {
    const results = await Promise.allSettled([
      renameColumn(database as never, scope, "board-1", "col-todo", {
        name: "Done",
      }),
      renameColumn(database as never, scope, "board-1", "col-doing", {
        name: "Done",
      }),
    ]);

    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConflictError);
    expect((rejected[0].reason as ConflictError).message).toBe(CLASH);
  });

  it("allows the same name on a different Board", async () => {
    await createColumn(database as never, scope, "board-2", { name: "To do" });

    expect(await columnNames("board-2")).toEqual(["To do"]);
  });
});
