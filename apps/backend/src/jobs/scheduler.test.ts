import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";

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
    $client: { connect: vi.fn<() => Promise<unknown>>() },
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

type FakeClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
  release: ReturnType<typeof vi.fn>;
};

/**
 * A stand-in for the node-postgres Pool behind `db`, modelling the one fact
 * the scheduler lock depends on: an advisory lock belongs to the connection
 * that took it, and only that connection can release it. `connect()` checks
 * out a dedicated connection; `db.execute` lands on whichever idle pooled
 * connection comes next, as a real pool's does.
 *
 * `held` maps a lock ID to the connection holding it. A lock still in it after
 * `runWithLock` returns is one no peer can take until pg-pool closes that
 * connection.
 */
const fakePg = ({ roundTripMs = 0 }: { roundTripMs?: number } = {}) => {
  const held = new Map<number, number>();
  const checkedOut: FakeClient[] = [];
  // Connections 0 and 1 sit idle in the pool; `connect()` opens 2 onwards.
  const idle = [0, 1];
  let nextId = 2;
  let nextIdle = 0;

  const run = async (connection: number, text: string, values: unknown[]) => {
    if (roundTripMs) await new Promise((r) => setTimeout(r, roundTripMs));
    const lockId = Number(values[0]);
    if (text.includes("pg_try_advisory_lock")) {
      const owner = held.get(lockId);
      if (owner === undefined) held.set(lockId, connection);
      return {
        rows: [{ acquired: owner === undefined || owner === connection }],
      };
    }
    if (text.includes("pg_advisory_unlock")) {
      const released = held.get(lockId) === connection;
      if (released) held.delete(lockId);
      return { rows: [{ released }] };
    }
    return { rows: [] };
  };

  mockDb.$client.connect.mockImplementation(() => {
    const connection = nextId++;
    const client: FakeClient = {
      query: (text, values = []) => run(connection, text, values),
      release: vi.fn(),
    };
    checkedOut.push(client);
    return Promise.resolve(client);
  });
  mockDb.execute.mockImplementation((query: SQL) => {
    const { sql: text, params } = dialect.sqlToQuery(query);
    const connection = idle[nextIdle++ % idle.length];
    return run(connection, text, params);
  });

  return { held, checkedOut };
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

  it("touches no events when no run was orphaned", async () => {
    const { updates } = captureUpdates([]);

    await recoverStuckTriggers();

    expect(updates.map((c) => c.table)).toEqual([triggerRunTable]);
  });

  it("reschedules every enabled cron Trigger left with a NULL nextRunAt and no running run", async () => {
    const { updates, selects } = captureUpdates(
      [],
      [cronTrigger({ cronExpression: "0 * * * *", timezone: "UTC" })],
    );

    await recoverStuckTriggers();

    // Not only the orphans' own Triggers: a claim never writes NULL any more,
    // so a NULL with no live run behind it is a stranded row, not a peer's
    // claim.
    const unscheduled = (type: number, enabled: number) =>
      `("trigger"."type" = $${type} and "trigger"."enabled" = $${enabled} and ` +
      `"trigger"."next_run_at" is null and not exists (select 1 from ` +
      `"trigger_run" where "trigger_run"."trigger_id" = "trigger"."id" and ` +
      `"trigger_run"."status" = 'running'))`;
    const { sql: text, params } = render(selects[0]);
    expect(text).toBe(unscheduled(1, 2));
    expect(params).toEqual(["cron", true]);

    const reschedule = updates[1];
    expect(reschedule.table).toBe(triggerTable);
    expect(reschedule.set.nextRunAt).toEqual(
      new Date("2026-08-30T13:00:00.000Z"),
    );
    // Rechecked at write time, so an edit or a claim in between wins.
    expect(render(reschedule.where).sql).toBe(
      `("trigger"."id" = $1 and ${unscheduled(2, 3)})`,
    );
  });

  it.each([
    ["a one-off Trigger", { cronExpression: "0 * * * *", isOneOff: true }, 0],
    ["a malformed config", { cronExpression: "" }, 1],
    ["an unparseable cron expression", { cronExpression: "not a cron" }, 1],
  ])("leaves %s unscheduled", async (_label, config, errors) => {
    const { updates } = captureUpdates([], [cronTrigger(config)]);

    await recoverStuckTriggers();

    expect(updates.map((c) => c.table)).toEqual([triggerRunTable]);
    expect(mockLogger.error).toHaveBeenCalledTimes(errors);
  });
});

describe("runWithLock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips the work when a peer holds the lock, and hands the connection back", async () => {
    const pg = fakePg();
    pg.held.set(42, 999);
    const work = vi.fn();

    await runWithLock(42, work);

    expect(work).not.toHaveBeenCalled();
    expect(pg.held.get(42)).toBe(999);
    expect(pg.checkedOut).toHaveLength(1);
    expect(pg.checkedOut[0].release).toHaveBeenCalledTimes(1);
  });

  it("releases the lock even when the work issues its own queries", async () => {
    const pg = fakePg();
    const work = vi.fn(async () => {
      // Each of these lands on some pooled connection, as the sweeps' do.
      // An even count matters: with the pool's two idle connections taken in
      // turn, a lock and unlock sent through the pool end up on different
      // ones, which is the bug this pins.
      await mockDb.execute(sql`SELECT 1`);
      await mockDb.execute(sql`SELECT 2`);
    });

    await runWithLock(42, work);

    expect(work).toHaveBeenCalledTimes(1);
    expect(pg.held.has(42)).toBe(false);
    expect(pg.checkedOut[0].release).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("lets the next tick take the lock again", async () => {
    const pg = fakePg();
    const work = vi.fn(async () => {
      await mockDb.execute(sql`SELECT 1`);
    });

    await runWithLock(42, work);
    await runWithLock(42, work);

    expect(work).toHaveBeenCalledTimes(2);
    expect(pg.held.has(42)).toBe(false);
  });

  it("releases the lock even when the work throws", async () => {
    const pg = fakePg();

    await expect(
      runWithLock(42, () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");

    expect(pg.held.has(42)).toBe(false);
    // The unlock worked, so the connection is fit to go back to the pool.
    expect(pg.checkedOut[0].release).toHaveBeenCalledWith(undefined);
  });

  it("discards the connection, and with it the lock, when the unlock fails", async () => {
    const pg = fakePg();

    await runWithLock(42, () => {
      // The lock is already taken by now; only the unlock hits this.
      const client = pg.checkedOut[0];
      client.query = () => Promise.reject(new Error("connection reset"));
      return Promise.resolve();
    });

    // Destroying the connection ends its session, which is what frees the
    // lock when the unlock itself could not.
    expect(pg.checkedOut[0].release).toHaveBeenCalledWith(expect.any(Error));
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ lockId: 42 }),
      expect.any(String),
    );
  });

  it("warns when the unlock reports the lock was not held", async () => {
    const pg = fakePg();

    await runWithLock(42, () => {
      pg.held.delete(42);
      return Promise.resolve();
    });

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ lockId: 42 }),
      expect.any(String),
    );
    expect(pg.checkedOut[0].release).toHaveBeenCalledTimes(1);
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
 * Every query a tick makes, answered by `answer` from the table it reads or
 * writes. A select's `fields` tell the running-run count apart, and `orderBy`
 * tells the due-Trigger read apart from the recovery sweep's.
 */
type Query = {
  op: "select" | "update";
  table: unknown;
  fields?: unknown;
  ordered: boolean;
};
const tickDb = (answer: (q: Query) => unknown[]) => {
  const chain = (q: Query): unknown => {
    const self: object = new Proxy(
      {},
      {
        get: (_, key) =>
          key === "then"
            ? (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
                Promise.resolve()
                  .then(() => answer(q))
                  .then(ok, ko)
            : (arg: unknown) => {
                if (key === "from") q.table = arg;
                if (key === "orderBy") q.ordered = true;
                return self;
              },
      },
    );
    return self;
  };
  mockDb.select.mockImplementation((fields?: unknown) =>
    chain({ op: "select", table: undefined, fields, ordered: false }),
  );
  mockDb.update.mockImplementation((table: unknown) =>
    chain({ op: "update", table, ordered: false }),
  );
};

/**
 * Scheduler ticks, end to end through the lock: both sweeps, then the due
 * cron Triggers.
 */
describe("startScheduler", () => {
  const weekly = {
    id: "weekly",
    name: "Weekly research",
    agentId: "a1",
    type: "cron",
    config: { cronExpression: "0 9 * * 1", timezone: "UTC" },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T08:59:59.000Z"));
    // Each round trip takes a few ms, as a real one does.
    pg = fakePg({ roundTripMs: 5 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  let pg: ReturnType<typeof fakePg>;

  /** The 09:00 tick finds `weekly` due and claims it; later ticks find none. */
  const weeklyDueOnce = (onQuery: (q: Query) => void = () => {}) => {
    let claimed = false;
    tickDb((q) => {
      onQuery(q);
      if (q.op === "select" && q.fields) return [{ running: 0 }];
      if (q.op === "select" && q.ordered) return claimed ? [] : [weekly];
      if (q.op === "update" && q.table === triggerTable && !claimed) {
        claimed = true;
        return [weekly];
      }
      return [];
    });
  };

  // #1158: the tick used to await every run it started while holding the
  // lock, so one long Cron run stopped both sweeps, on every instance, until
  // it ended.
  it("sweeps on every tick, on any instance, while a 45-minute Cron run is going", async () => {
    const sweepTimes: string[] = [];
    weeklyDueOnce((q) => {
      if (q.op === "update" && q.table === chatTable) {
        sweepTimes.push(new Date().toISOString().slice(11, 16));
      }
    });
    mockFireTrigger.mockImplementation(
      () =>
        new Promise((resolve) => setTimeout(() => resolve("ran"), 45 * 60_000)),
    );

    startScheduler(); // backend instance A
    startScheduler(); // backend instance B, sharing the database lock

    await vi.advanceTimersByTimeAsync(1_050); // through the 09:00 tick
    expect(mockFireTrigger).toHaveBeenCalledTimes(1);
    expect(sweepTimes).toEqual(["09:00"]);

    await vi.advanceTimersByTimeAsync(30 * 60_000); // to 09:30
    // One sweep a minute: whichever instance wins each tick runs it.
    expect(sweepTimes).toEqual(
      Array.from({ length: 31 }, (_, i) => `09:${String(i).padStart(2, "0")}`),
    );
    expect(mockFireTrigger).toHaveBeenCalledTimes(1);
  });

  it("releases the lock while a run it started never finishes", async () => {
    weeklyDueOnce();
    mockFireTrigger.mockReturnValue(new Promise(() => {}));

    startScheduler();
    await vi.advanceTimersByTimeAsync(1_050);

    expect(mockFireTrigger).toHaveBeenCalledTimes(1);
    expect(pg.held.size).toBe(0);
    expect(pg.checkedOut[0].release).toHaveBeenCalledTimes(1);
  });

  it("still sweeps Chats and fires due Triggers when the Trigger sweep fails", async () => {
    const tables: unknown[] = [];
    weeklyDueOnce((q) => {
      if (q.op === "update" && q.table === triggerRunTable) {
        throw new Error("sweep down");
      }
      if (q.op === "update") tables.push(q.table);
    });
    mockFireTrigger.mockResolvedValue("ran");

    startScheduler();
    await vi.advanceTimersByTimeAsync(1_050);

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.anything(),
      "Trigger recovery sweep failed",
    );
    expect(tables).toEqual([chatTable, triggerTable]);
    expect(mockFireTrigger).toHaveBeenCalledTimes(1);
  });
});
