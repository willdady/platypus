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

const { mockDb, mockFireTrigger } = vi.hoisted(() => ({
  mockDb: {
    update: vi.fn<(table: unknown) => unknown>(),
    select: vi.fn(),
    execute: vi.fn<(query: SQL) => Promise<unknown>>(),
  },
  mockFireTrigger: vi.fn(),
}));

vi.mock("../index.ts", () => ({ db: mockDb }));
vi.mock("../services/trigger-firing.ts", () => ({
  fireTrigger: mockFireTrigger,
}));

import { mockLogger } from "../test-setup.ts";

import {
  recoverStuckChats,
  recoverStuckTriggers,
  runWithLock,
  scheduleAligned,
  startScheduler,
  stuckChatCutoff,
  stuckTriggerCutoff,
} from "./scheduler.ts";
import {
  chat as chatTable,
  trigger as triggerTable,
  triggerRun as triggerRunTable,
  triggerRunEvent as triggerRunEventTable,
} from "../db/schema.ts";

const dialect = new PgDialect();

type Captured = { table: unknown; set: Record<string, unknown>; where?: SQL };

/**
 * Records every update chain in order. A sweep's update ends in
 * `.returning()`; the event update and the claim are awaited straight off
 * `.where()`, so the object `where` hands back is both thenable and has
 * `returning`. `selected` is what every `select` resolves to, its predicates
 * recorded in `selects`.
 */
const captureUpdates = (
  returning: unknown[],
  selected: unknown[] = [],
): { updates: Captured[]; selects: SQL[] } => {
  const updates: Captured[] = [];
  const selects: SQL[] = [];
  mockDb.update.mockImplementation((table: unknown) => ({
    set: (values: Record<string, unknown>) => {
      const entry: Captured = { table, set: values };
      updates.push(entry);
      return {
        where: (predicate: SQL) => {
          entry.where = predicate;
          return {
            returning: () => Promise.resolve(returning),
            then: (
              resolve: (v: unknown) => unknown,
              reject?: (e: unknown) => unknown,
            ) => Promise.resolve(undefined).then(resolve, reject),
          };
        },
      };
    },
  }));
  mockDb.select.mockReturnValue({
    from: () => ({
      where: (predicate: SQL) => {
        selects.push(predicate);
        return Promise.resolve(selected);
      },
    }),
  });
  return { updates, selects };
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

describe("stuckTriggerCutoff", () => {
  beforeEach(() => {
    delete process.env.TRIGGER_PER_RUN_TIMEOUT_MS;
  });

  afterEach(() => {
    delete process.env.TRIGGER_PER_RUN_TIMEOUT_MS;
    vi.useRealTimers();
  });

  it("sits one stale buffer past the default Trigger per-run timeout", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));

    // 60 min per-run timeout + 5 min buffer = 65 min — not the registry's
    // 10-minute fallback, which would fail live Trigger runs at 15.
    expect(stuckTriggerCutoff().toISOString()).toBe("2026-08-30T10:55:00.000Z");
  });

  it("tracks TRIGGER_PER_RUN_TIMEOUT_MS", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
    process.env.TRIGGER_PER_RUN_TIMEOUT_MS = String(2 * 60 * 60 * 1000);

    // 120 min per-run timeout + 5 min buffer = 125 min.
    expect(stuckTriggerCutoff().toISOString()).toBe("2026-08-30T09:55:00.000Z");
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
    const { updates } = captureUpdates([{ id: "chat-1" }]);

    await recoverStuckChats();

    const captured = updates[0];
    expect(captured.table).toBe(chatTable);
    expect(captured.set).toMatchObject({ status: "failed" });

    // The whole predicate, pinned exactly. Asserting the rendered string
    // rather than fragments of it is what makes this a real test: it fails
    // if the comparison flips direction (a `>` would sweep every live turn
    // and spare every dead one), if the anchor moves to `updated_at`, or if
    // the `running` guard is dropped. The `updated_at` fallback is a second
    // disjunct rather than a COALESCE, reached only when `last_turn_at` is
    // NULL, so a row with a turn timestamp is never judged on the timestamp
    // auto-titling and memory extraction bump.
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

  it("logs the sweep at warn with the row count and cutoff", async () => {
    captureUpdates([{ id: "chat-1" }, { id: "chat-2" }]);

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
    captureUpdates([]);

    await recoverStuckChats();

    expect(mockLogger.warn).not.toHaveBeenCalled();
  });
});

/**
 * The Trigger sweep's half of "no terminal run leaves an open event" (#647).
 * Rendered the same way as the Chat sweep above: the behaviour is the
 * predicate, so the predicate is what is pinned.
 */
describe("recoverStuckTriggers", () => {
  const cronTrigger = (config: Record<string, unknown>) => ({
    id: "t1",
    name: "Nightly",
    type: "cron",
    config,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.TRIGGER_PER_RUN_TIMEOUT_MS;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
  });

  afterEach(() => {
    delete process.env.TRIGGER_PER_RUN_TIMEOUT_MS;
    vi.useRealTimers();
  });

  it("fails only `running` rows started before the Trigger per-run timeout plus the buffer", async () => {
    process.env.TRIGGER_PER_RUN_TIMEOUT_MS = String(90 * 60 * 1000);
    const { updates } = captureUpdates([]);

    await recoverStuckTriggers();

    const runs = updates[0];
    expect(runs.table).toBe(triggerRunTable);
    expect(runs.set).toMatchObject({
      status: "failed",
      errorMessage: "Server restarted during execution",
    });
    const { sql: text, params } = render(runs.where);
    expect(text).toBe(
      `("trigger_run"."status" = $1 and "trigger_run"."started_at" < $2)`,
    );
    // 12:00 − (90 min + 5 min buffer).
    expect(params).toEqual(["running", "2026-08-30T10:25:00.000Z"]);
  });

  it("closes the orphaned runs' still-open events as errors, with no duration", async () => {
    const { updates } = captureUpdates([
      { id: "run-1", triggerId: "t1" },
      { id: "run-2", triggerId: "t2" },
    ]);

    await recoverStuckTriggers();

    expect(updates.map((c) => c.table)).toEqual([
      triggerRunTable,
      triggerRunEventTable,
    ]);
    const events = updates[1];
    // Status only. A duration would claim to know when the event ended, and
    // the whole point of this path is that nobody does.
    expect(events.set).toEqual({ status: "error" });
    const { sql: text, params } = render(events.where);
    expect(text).toBe(
      `("trigger_run_event"."run_id" in ($1, $2) and "trigger_run_event"."status" = $3)`,
    );
    expect(params).toEqual(["run-1", "run-2", "running"]);
  });

  it("touches no events and reads no Triggers when no run was orphaned", async () => {
    const { updates } = captureUpdates([]);

    await recoverStuckTriggers();

    expect(updates.map((c) => c.table)).toEqual([triggerRunTable]);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("reschedules only the claimed cron Triggers whose runs it just failed", async () => {
    const { updates, selects } = captureUpdates(
      [
        { id: "run-1", triggerId: "t1" },
        { id: "run-2", triggerId: "t1" },
      ],
      [cronTrigger({ cronExpression: "0 * * * *", timezone: "UTC" })],
    );

    await recoverStuckTriggers();

    // Restricted to the orphans' own Triggers, once each: a NULL `nextRunAt`
    // with no stale run behind it is a peer's live claim, not a stuck row.
    const { sql: text, params } = render(selects[0]);
    expect(text).toBe(
      `("trigger"."id" in ($1) and "trigger"."type" = $2 and ` +
        `"trigger"."enabled" = $3 and "trigger"."next_run_at" is null)`,
    );
    expect(params).toEqual(["t1", "cron", true]);

    const reschedule = updates[2];
    expect(reschedule.table).toBe(triggerTable);
    expect(reschedule.set.nextRunAt).toEqual(
      new Date("2026-08-30T13:00:00.000Z"),
    );
    expect(render(reschedule.where).params).toEqual(["t1"]);
  });

  it.each([
    ["a one-off Trigger", { cronExpression: "0 * * * *", isOneOff: true }, 0],
    ["a malformed config", { cronExpression: "" }, 1],
    ["an unparseable cron expression", { cronExpression: "not a cron" }, 1],
  ])("leaves %s unscheduled", async (_label, config, errors) => {
    const { updates } = captureUpdates(
      [{ id: "run-1", triggerId: "t1" }],
      [cronTrigger(config)],
    );

    await recoverStuckTriggers();

    expect(updates.map((c) => c.table)).toEqual([
      triggerRunTable,
      triggerRunEventTable,
    ]);
    expect(mockLogger.error).toHaveBeenCalledTimes(errors);
  });
});

describe("runWithLock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const lockAcquired = (acquired: boolean) =>
    mockDb.execute.mockResolvedValue({ rows: [{ acquired }] });

  it("skips the work, and releases nothing, when a peer holds the lock", async () => {
    lockAcquired(false);
    const work = vi.fn();

    await runWithLock(42, work);

    expect(work).not.toHaveBeenCalled();
    expect(mockDb.execute).toHaveBeenCalledTimes(1);
    expect(render(mockDb.execute.mock.calls[0][0])).toMatchObject({
      sql: "SELECT pg_try_advisory_lock($1) as acquired",
      params: [42],
    });
  });

  it("releases the lock even when the work throws", async () => {
    lockAcquired(true);

    await expect(
      runWithLock(42, () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");

    expect(render(mockDb.execute.mock.calls[1][0])).toMatchObject({
      sql: "SELECT pg_advisory_unlock($1)",
      params: [42],
    });
  });
});

describe("scheduleAligned", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // 20s past the minute: the next boundary is 40s away, not 60.
    vi.setSystemTime(new Date("2026-08-30T12:00:20.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A job that takes a few ms, as any real one does. */
  const takesTime = () => new Promise<void>((r) => setTimeout(r, 5));

  it("fires on the next wall-clock boundary rather than an interval after boot", async () => {
    const job = vi.fn(takesTime);

    scheduleAligned("test", 60_000, job);

    await vi.advanceTimersByTimeAsync(39_999);
    expect(job).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(job).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(job).toHaveBeenCalledTimes(2);
  });

  it("waits a full interval after a job that finishes on the boundary", async () => {
    const job = vi.fn(async () => {});

    scheduleAligned("test", 60_000, job);

    await vi.advanceTimersByTimeAsync(40_000);
    expect(job).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(job).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(job).toHaveBeenCalledTimes(2);
  });

  it("logs a failed run and keeps the schedule going", async () => {
    const job = vi.fn(takesTime).mockImplementationOnce(async () => {
      await takesTime();
      throw new Error("boom");
    });

    scheduleAligned("test", 60_000, job);

    await vi.advanceTimersByTimeAsync(40_010);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ job: "test" }),
      "Scheduled job failed",
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(job).toHaveBeenCalledTimes(2);
  });
});

/**
 * One scheduler tick, end to end through the lock: both sweeps, then the due
 * cron Triggers.
 */
describe("startScheduler", () => {
  const due = [
    { id: "t1", name: "A", agentId: "a1" },
    { id: "t2", name: "B", agentId: "a1" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:59.000Z"));
    // Each round trip takes a few ms, as a real one does.
    mockDb.execute.mockImplementation(
      () =>
        new Promise((r) =>
          setTimeout(() => r({ rows: [{ acquired: true }] }), 5),
        ),
    );
    mockFireTrigger.mockResolvedValue("succeeded");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Advance to the next minute and let the tick run through its unlock. */
  const tick = async () => {
    startScheduler();
    await vi.advanceTimersByTimeAsync(1_000 + 10);
    expect(mockDb.execute).toHaveBeenCalledTimes(2);
  };

  it("claims every due Trigger before firing any of them", async () => {
    const { updates } = captureUpdates([], due);
    const claimedBeforeFire: boolean[] = [];
    mockFireTrigger.mockImplementation(() => {
      claimedBeforeFire.push(updates.some((u) => u.table === triggerTable));
      return Promise.resolve("succeeded");
    });

    await tick();

    const claim = updates.find((u) => u.table === triggerTable)!;
    // NULL is the claim: `nextRunAt <= NOW()` is false for it, so no later
    // tick (on this instance or a peer) can pick the Trigger up again.
    expect(claim.set).toEqual({ nextRunAt: null });
    expect(render(claim.where).params).toEqual(["t1", "t2"]);
    expect(mockFireTrigger.mock.calls).toEqual([
      [due[0], { kind: "cron" }],
      [due[1], { kind: "cron" }],
    ]);
    expect(claimedBeforeFire).toEqual([true, true]);
  });

  it("still sweeps Chats and fires due Triggers when the Trigger sweep fails", async () => {
    const { updates } = captureUpdates([], due);
    const update = mockDb.update.getMockImplementation()!;
    mockDb.update.mockImplementation((table: unknown) => {
      if (table === triggerRunTable) throw new Error("sweep down");
      return update(table);
    });

    await tick();

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.anything(),
      "Trigger recovery sweep failed",
    );
    expect(updates.map((u) => u.table)).toEqual([chatTable, triggerTable]);
    expect(mockFireTrigger).toHaveBeenCalledTimes(2);
  });
});
