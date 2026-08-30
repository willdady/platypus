import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

/**
 * Unlike most backend tests, this file does NOT import `../test-utils.ts`:
 * that module mocks `drizzle-orm` itself, which would replace `and`/`isNull`
 * with spies and leave nothing to render. The stuck-Chat sweep's whole
 * behaviour lives in the predicate it hands Postgres, so the test keeps
 * drizzle real and renders the query instead.
 */

const { mockDb, mockLogger } = vi.hoisted(() => ({
  mockDb: {
    update: vi.fn(),
  },
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../index.ts", () => ({ db: mockDb }));
vi.mock("../logger.ts", () => ({ logger: mockLogger }));

import { recoverStuckChats, stuckChatCutoff } from "./scheduler.ts";
import { chat as chatTable } from "../db/schema.ts";

const dialect = new PgDialect();

/** Records the `.set()` payload and `.where()` predicate of one update chain. */
const captureUpdate = (returning: unknown[]) => {
  const captured: { set?: Record<string, unknown>; where?: SQL } = {};
  mockDb.update.mockReturnValue({
    set: (values: Record<string, unknown>) => {
      captured.set = values;
      return {
        where: (predicate: SQL) => {
          captured.where = predicate;
          return { returning: () => Promise.resolve(returning) };
        },
      };
    },
  });
  return captured;
};

/** The rendered SQL + bound parameters of a where clause. */
const render = (predicate: SQL | undefined) => {
  if (!predicate) throw new Error("No where clause was captured");
  return dialect.sqlToQuery(predicate);
};

describe("stuckChatCutoff", () => {
  beforeEach(() => {
    delete process.env.CHAT_PER_RUN_TIMEOUT_MS;
  });

  afterEach(() => {
    delete process.env.CHAT_PER_RUN_TIMEOUT_MS;
    vi.useRealTimers();
  });

  it("sits one stale buffer past the default Chat per-run timeout", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));

    // 30 min per-run timeout + 5 min buffer = 35 min.
    expect(stuckChatCutoff().toISOString()).toBe("2026-08-30T11:25:00.000Z");
  });

  it("tracks CHAT_PER_RUN_TIMEOUT_MS, not the Trigger per-run timeout", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
    process.env.CHAT_PER_RUN_TIMEOUT_MS = String(60 * 60 * 1000);

    // 60 min per-run timeout + 5 min buffer = 65 min.
    expect(stuckChatCutoff().toISOString()).toBe("2026-08-30T10:55:00.000Z");
  });
});

describe("recoverStuckChats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CHAT_PER_RUN_TIMEOUT_MS;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
  });

  afterEach(() => {
    delete process.env.CHAT_PER_RUN_TIMEOUT_MS;
    vi.useRealTimers();
  });

  it("fails `running` Chats whose turn started before the cutoff", async () => {
    const captured = captureUpdate([{ id: "chat-1" }]);

    await recoverStuckChats();

    expect(captured.set).toMatchObject({ status: "failed" });

    // The whole predicate, pinned exactly. Asserting the rendered string
    // rather than fragments of it is what makes this a real test: it fails
    // if the comparison flips direction (a `>` would sweep every live turn
    // and spare every dead one), if the anchor moves to `updated_at`, or if
    // the `running` guard is dropped.
    const { sql: text, params } = render(captured.where);
    expect(text).toBe(
      `("chat"."status" = $1 and ("chat"."last_turn_at" < $2 or ` +
        `("chat"."last_turn_at" is null and "chat"."updated_at" < $3)))`,
    );
    // 12:00 − (30 min + 5 min buffer): the peer-safety window, bound as a
    // UTC `timestamp` parameter exactly as the Trigger sweep binds its own.
    expect(params).toEqual([
      "running",
      "2026-08-30T11:25:00.000Z",
      "2026-08-30T11:25:00.000Z",
    ]);
  });

  it("falls back to `updatedAt` for rows with no `lastTurnAt`", async () => {
    const captured = captureUpdate([{ id: "chat-1" }]);

    await recoverStuckChats();

    // The fallback is a second disjunct rather than a COALESCE so both
    // comparisons stay on real columns and drizzle binds the cutoff through
    // each column's own encoder. It is reached only when `last_turn_at` is
    // NULL, so a row that has a turn timestamp is never judged on the
    // timestamp auto-titling and memory extraction bump.
    const { sql: text } = render(captured.where);
    expect(text).toContain(
      `("chat"."last_turn_at" is null and "chat"."updated_at" < $3)`,
    );
  });

  it("logs the sweep at warn with the row count and cutoff", async () => {
    captureUpdate([{ id: "chat-1" }, { id: "chat-2" }]);

    await recoverStuckChats();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        count: 2,
        cutoff: "2026-08-30T11:25:00.000Z",
      }),
      expect.stringContaining("Chat"),
    );
  });

  it("stays quiet when nothing is stuck", async () => {
    captureUpdate([]);

    await recoverStuckChats();

    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("targets the chat table", async () => {
    captureUpdate([]);

    await recoverStuckChats();

    expect(mockDb.update).toHaveBeenCalledWith(chatTable);
  });
});
