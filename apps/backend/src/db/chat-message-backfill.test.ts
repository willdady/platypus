import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

/**
 * The `chat.messages` → `chat_message` backfill (#711), run for real against an
 * in-process Postgres: the DDL that creates the table, then the backfill file
 * itself, over a `chat` table cut down to the columns they touch.
 */
const migration = (name: string) =>
  readFileSync(new URL(`../../drizzle/${name}`, import.meta.url), "utf8");

/** Runs a migration file the way the migrator does: statement by statement. */
const apply = async (db: PGlite, name: string) => {
  for (const statement of migration(name).split("--> statement-breakpoint")) {
    await db.exec(statement);
  }
};

// One Postgres for the file: booting PGlite compiles its WASM, which on a
// loaded CI runner alone outlasts a test's default timeout.
let db: PGlite;
beforeAll(async () => {
  db = await PGlite.create();
}, 60_000);
afterAll(() => db.close());

/** A fresh schema holding `chat` as it stood before 0071, plus these rows. */
const setup = async (chats: { id: string; messages: unknown }[]) => {
  await db.exec(`
    DROP SCHEMA public CASCADE;
    CREATE SCHEMA public;
    CREATE TABLE "chat" (
      "id" text PRIMARY KEY,
      "messages" jsonb,
      "created_at" timestamp NOT NULL DEFAULT '2026-01-01T00:00:00Z'
    );
  `);
  await apply(db, "0071_chat_message_table.sql");
  for (const chat of chats) {
    await db.query(`INSERT INTO "chat" ("id", "messages") VALUES ($1, $2)`, [
      chat.id,
      chat.messages === null ? null : JSON.stringify(chat.messages),
    ]);
  }
  return db;
};

type Row = {
  id: string;
  role: string;
  parts: unknown;
  metadata: unknown;
};

/** The Active path: from the Chat's leaf, up through each parent. */
const activePath = async (db: PGlite, chatId: string): Promise<Row[]> => {
  const { rows } = await db.query<Row>(
    `WITH RECURSIVE path AS (
       SELECT m.*, 0 AS depth FROM chat_message m
         JOIN chat c ON c.id = m.chat_id AND c.active_leaf_id = m.id
         WHERE c.id = $1
       UNION ALL
       SELECT m.*, path.depth + 1 FROM chat_message m
         JOIN path ON m.chat_id = path.chat_id AND m.id = path.parent_id
     )
     SELECT id, role, parts, metadata FROM path ORDER BY depth DESC`,
    [chatId],
  );
  return rows;
};

const asRow = ({ metadata, ...message }: Record<string, unknown>) => ({
  ...message,
  metadata: metadata ?? null,
});

describe("0072 chat_message backfill", () => {
  const user = {
    id: "u1",
    role: "user",
    parts: [
      {
        type: "file",
        mediaType: "image/png",
        filename: "otter.png",
        url: "storage://org-1/ws-1/chat-1/u1/0-aaaaaaaa.png",
      },
      { type: "text", text: "What is this?" },
    ],
  };
  const reply = {
    id: "a1",
    role: "assistant",
    parts: [{ type: "text", text: "An otter." }],
    metadata: { contextOccupancy: 1200 },
  };
  const command = {
    id: "u2",
    role: "user",
    parts: [{ type: "text", text: "/blog-post about otters" }],
  };
  const loadSkill = {
    type: "tool-loadSkill",
    toolCallId: "call-1",
    state: "output-available",
    input: { name: "blog-post" },
    output: { name: "blog-post", body: "Write a blog post." },
  };
  // #649: a mid-flush write stored the seeded message, then its continuation
  // under the same id.
  const seeded = { id: "a2", role: "assistant", parts: [loadSkill] };
  const answered = {
    id: "a2",
    role: "assistant",
    parts: [loadSkill, { type: "text", text: "Otters hold hands." }],
  };

  it("turns each array into a chain whose Active path is the array", async () => {
    const db = await setup([
      { id: "chat-1", messages: [user, reply, command, seeded, answered] },
      { id: "chat-null", messages: null },
      { id: "chat-empty", messages: [] },
    ]);
    await apply(db, "0072_backfill_chat_messages.sql");

    expect(await activePath(db, "chat-1")).toEqual(
      [user, reply, command, answered].map(asRow),
    );

    const { rows } = await db.query<{ id: string; parent_id: string | null }>(
      `SELECT id, parent_id FROM chat_message WHERE chat_id = 'chat-1'
       ORDER BY created_at`,
    );
    expect(rows).toEqual([
      { id: "u1", parent_id: null },
      { id: "a1", parent_id: "u1" },
      { id: "u2", parent_id: "a1" },
      { id: "a2", parent_id: "u2" },
    ]);

    const leaves = await db.query<{ id: string; active_leaf_id: unknown }>(
      `SELECT id, active_leaf_id FROM chat ORDER BY id`,
    );
    expect(leaves.rows).toEqual([
      { id: "chat-1", active_leaf_id: "a2" },
      { id: "chat-empty", active_leaf_id: null },
      { id: "chat-null", active_leaf_id: null },
    ]);
  });

  it.each([
    ["a non-object element", ["hello"]],
    ["a message with no id", [{ role: "user", parts: [] }]],
    [
      "a message whose id is not a string",
      [{ id: 7, role: "user", parts: [] }],
    ],
    [
      "a non-adjacent duplicate id",
      [
        { id: "u1", role: "user", parts: [] },
        { id: "a1", role: "assistant", parts: [] },
        { id: "u1", role: "user", parts: [] },
      ],
    ],
  ])("fails the migration on %s, naming the Chat", async (_, messages) => {
    const db = await setup([
      { id: "chat-ok", messages: [user] },
      { id: "chat-bad", messages },
    ]);

    await expect(apply(db, "0072_backfill_chat_messages.sql")).rejects.toThrow(
      /chat-bad/,
    );
    const { rows } = await db.query(`SELECT 1 FROM chat_message`);
    expect(rows).toHaveLength(0);
  });
});

describe("0071 / 0073 chat_message DDL", () => {
  it.each([
    "0071_chat_message_table.sql",
    "0073_drop_chat_messages_column.sql",
  ])("%s is pure DDL — the backfill lives in 0072", (name) => {
    expect(migration(name)).not.toMatch(/INSERT INTO/i);
  });
});
