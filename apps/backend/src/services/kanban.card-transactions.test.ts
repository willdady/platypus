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
import { ConflictError, NotFoundError } from "../errors.ts";
import type { db } from "../index.ts";
import { dispatchEvent } from "./event-dispatch.ts";
import { bulkUpdateCards, moveCard } from "./kanban-card.ts";

vi.mock("./event-dispatch.ts", () => ({ dispatchEvent: vi.fn() }));

type Database = typeof db;

let pg: PGlite;
let database: ReturnType<typeof drizzle>;
beforeAll(async () => {
  pg = await migratedPglite();
  database = drizzle(pg);
}, 60_000);
afterAll(() => pg.close());

const ctx = {
  orgId: "org-1",
  workspaceId: "ws-1",
  actor: { agentId: "agent-1" },
};

beforeEach(async () => {
  vi.mocked(dispatchEvent).mockClear();
  await pg.exec(`
    DELETE FROM "organization";
    DELETE FROM "user";
    INSERT INTO "user" ("id", "name", "email", "email_verified", "created_at", "updated_at")
      VALUES ('u1', 'Jane', 'jane@example.com', true, now(), now());
    INSERT INTO "organization" ("id", "name") VALUES ('org-1', 'Acme');
    INSERT INTO "workspace" ("id", "organization_id", "owner_id", "name")
      VALUES ('ws-1', 'org-1', 'u1', 'Support');
    INSERT INTO "kanban_board" ("id", "workspace_id", "name")
      VALUES ('board-1', 'ws-1', 'Work');
    INSERT INTO "kanban_column" ("id", "board_id", "name", "position") VALUES
      ('col-old', 'board-1', 'Doing', 1),
      ('col-new', 'board-1', 'Done', 2),
      ('col-side', 'board-1', 'Parked', 3);
    INSERT INTO "kanban_card" ("id", "column_id", "title", "position")
      VALUES ('card-1', 'col-old', 'Move me', 1);
  `);
});

const cardRow = async (id: string) =>
  (
    await pg.query<{ column_id: string; position: number }>(
      `SELECT "column_id", "position" FROM "kanban_card" WHERE "id" = $1`,
      [id],
    )
  ).rows[0];

const positionOf = async (id: string) => (await cardRow(id)).position;

describe("moveCard against a real database", () => {
  it("leaves the row alone when the card has left the expected column", async () => {
    await pg.exec(
      `UPDATE "kanban_card" SET "column_id" = 'col-side' WHERE "id" = 'card-1';`,
    );

    await expect(
      moveCard(database as unknown as Database, ctx, {
        cardId: "card-1",
        columnId: "col-new",
        afterCardId: null,
        expectedColumnId: "col-old",
      }),
    ).rejects.toThrow(ConflictError);

    expect(await cardRow("card-1")).toEqual({
      column_id: "col-side",
      position: 1,
    });
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it("rolls the rebalance back when the move is refused", async () => {
    await pg.exec(`
      UPDATE "kanban_card" SET "column_id" = 'col-side' WHERE "id" = 'card-1';
      INSERT INTO "kanban_card" ("id", "column_id", "title", "position") VALUES
        ('card-2', 'col-new', 'Anchor', 1.2),
        ('card-3', 'col-new', 'Follower', 1.2005);
      CREATE SEQUENCE "rebalance_probe";
      CREATE FUNCTION "probe_position_write"() RETURNS trigger AS $$
      BEGIN
        IF NEW."position" IS DISTINCT FROM OLD."position" THEN
          PERFORM nextval('rebalance_probe');
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER "probe_position_write"
        BEFORE UPDATE ON "kanban_card"
        FOR EACH ROW EXECUTE FUNCTION "probe_position_write"();
    `);

    try {
      await expect(
        moveCard(database as unknown as Database, ctx, {
          cardId: "card-1",
          columnId: "col-new",
          afterCardId: "card-2",
          expectedColumnId: "col-old",
        }),
      ).rejects.toThrow(ConflictError);

      expect(await positionOf("card-2")).toBe(1.2);
      expect(await positionOf("card-3")).toBe(1.2005);
      expect((await cardRow("card-1")).column_id).toBe("col-side");
      const probe = await pg.query<{ last_value: number | bigint }>(
        `SELECT last_value FROM "rebalance_probe"`,
      );
      expect(Number(probe.rows[0].last_value)).toBe(2);
      expect(dispatchEvent).not.toHaveBeenCalled();
    } finally {
      await pg.exec(`
        DROP TRIGGER IF EXISTS "probe_position_write" ON "kanban_card";
        DROP FUNCTION IF EXISTS "probe_position_write"();
        DROP SEQUENCE IF EXISTS "rebalance_probe";
      `);
    }
  });
});

describe("bulkUpdateCards against a real database", () => {
  it("throws NotFoundError when the card is deleted before its write", async () => {
    await pg.exec(`
      CREATE FUNCTION "vanish_before_update"() RETURNS trigger AS $$
      BEGIN
        DELETE FROM "kanban_card" WHERE "id" = OLD."id";
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER "vanish_before_update"
        BEFORE UPDATE ON "kanban_card"
        FOR EACH ROW EXECUTE FUNCTION "vanish_before_update"();
    `);

    try {
      await expect(
        bulkUpdateCards(database as unknown as Database, ctx, {
          cardIds: ["card-1"],
          priority: "high",
        }),
      ).rejects.toThrow(new NotFoundError("Card not found"));

      expect(dispatchEvent).not.toHaveBeenCalled();
      expect(await cardRow("card-1")).toBeDefined();
    } finally {
      await pg.exec(`
        DROP TRIGGER IF EXISTS "vanish_before_update" ON "kanban_card";
        DROP FUNCTION IF EXISTS "vanish_before_update"();
      `);
    }
  });
});
