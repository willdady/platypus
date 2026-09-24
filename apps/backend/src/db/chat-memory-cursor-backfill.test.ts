import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

/**
 * The memory extraction cursor's starting point (#990), run for real against
 * an in-process Postgres over `chat` and `chat_message` cut down to the
 * columns the migration touches.
 */
const migration = readFileSync(
  new URL("../../drizzle/0074_chat_memory_cursor.sql", import.meta.url),
  "utf8",
);

let db: PGlite;
beforeAll(async () => {
  db = await PGlite.create();
}, 60_000);
afterAll(() => db.close());

const T = (minutes: number) =>
  new Date(Date.UTC(2026, 8, 1, 12, minutes)).toISOString();

type Chat = {
  id: string;
  status: string;
  processedAt: string | null;
  turnAt: string | null;
};

/** Applies the migration over these Chats, each with one message as its leaf. */
const migrate = async (chats: Chat[]) => {
  await db.exec(`
    DROP SCHEMA public CASCADE;
    CREATE SCHEMA public;
    CREATE TABLE "chat" (
      "id" text PRIMARY KEY,
      "active_leaf_id" text,
      "memory_extraction_status" text DEFAULT 'pending',
      "last_memory_processed_at" timestamp,
      "last_turn_at" timestamp
    );
    CREATE TABLE "chat_message" (
      "chat_id" text NOT NULL REFERENCES "chat"("id") ON DELETE cascade,
      "id" text NOT NULL,
      PRIMARY KEY ("chat_id", "id")
    );
  `);
  for (const chat of chats) {
    await db.query(`INSERT INTO "chat" VALUES ($1, NULL, $2, $3, $4)`, [
      chat.id,
      chat.status,
      chat.processedAt,
      chat.turnAt,
    ]);
    await db.query(`INSERT INTO "chat_message" VALUES ($1, 'leaf')`, [chat.id]);
    await db.query(
      `UPDATE "chat" SET "active_leaf_id" = 'leaf' WHERE "id" = $1`,
      [chat.id],
    );
  }
  for (const statement of migration.split("--> statement-breakpoint")) {
    await db.exec(statement);
  }
  const { rows } = await db.query<{ id: string; memory_cursor_id: string }>(
    `SELECT "id", "memory_cursor_id" FROM "chat" ORDER BY "id"`,
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.memory_cursor_id]));
};

describe("0074 memory cursor backfill", () => {
  it("starts a caught-up Chat at its leaf and every other Chat at null", async () => {
    expect(
      await migrate([
        {
          id: "caught-up",
          status: "completed",
          processedAt: T(10),
          turnAt: T(5),
        },
        {
          id: "same-moment",
          status: "completed",
          processedAt: T(5),
          turnAt: T(5),
        },
        // No turn since `last_turn_at` began, so nothing says it was read.
        { id: "legacy", status: "completed", processedAt: T(10), turnAt: null },
        {
          id: "turn-since",
          status: "completed",
          processedAt: T(5),
          turnAt: T(10),
        },
        { id: "failed", status: "failed", processedAt: T(10), turnAt: T(5) },
        {
          id: "processing",
          status: "processing",
          processedAt: T(10),
          turnAt: T(5),
        },
        {
          id: "never-read",
          status: "pending",
          processedAt: null,
          turnAt: T(5),
        },
      ]),
    ).toEqual({
      "caught-up": "leaf",
      "same-moment": "leaf",
      legacy: null,
      "turn-since": null,
      failed: null,
      processing: null,
      "never-read": null,
    });
  });
});
