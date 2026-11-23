import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from "vitest";
import { type SQL } from "drizzle-orm";
import { mockDb as sharedMockDb, renderSql } from "../test-utils.ts";

type SchedulerDb = {
  update: Mock<(table: unknown) => unknown>;
  select: Mock<(...args: unknown[]) => unknown>;
  execute: Mock<(query: SQL) => Promise<unknown>>;
  $client: { connect: Mock<() => Promise<unknown>> };
};

const mockDb = sharedMockDb as unknown as SchedulerDb;
mockDb.$client = { connect: vi.fn() };

const {
  mockFireTrigger,
  mockSendReminders,
  mockSendA2aReminders,
  mockAnnounce,
} = vi.hoisted(() => ({
  mockFireTrigger: vi.fn(),
  mockSendReminders: vi.fn<(now: Date) => Promise<void>>(),
  mockSendA2aReminders: vi.fn<(now: Date) => Promise<void>>(),
  mockAnnounce: vi.fn(),
}));

vi.mock("../services/trigger-firing.ts", () => ({
  fireTrigger: mockFireTrigger,
}));
vi.mock("../services/inbound-trigger.ts", () => ({
  sendInboundTokenReminders: mockSendReminders,
}));
vi.mock("../services/a2a-token.ts", () => ({
  sendA2aTokenReminders: mockSendA2aReminders,
}));
vi.mock("../services/trigger-run-announce.ts", () => ({
  endedTriggerRunColumns: {},
  announceTriggerRunsEnded: mockAnnounce,
}));

import { mockLogger } from "../test-setup.ts";

import {
  recoverStuckChats,
  recoverStuckTriggers,
  resetTokenReminderSweep,
  scheduleAligned,
  startScheduler,
  stuckTriggerCutoff,
  sweepTokenRemindersIfDue,
} from "./scheduler.ts";
import {
  chat as chatTable,
  trigger as triggerTable,
  triggerRun as triggerRunTable,
  triggerRunEvent as triggerRunEventTable,
} from "../db/schema.ts";

type Captured = { table: unknown; set: Record<string, unknown>; where?: SQL };

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

const render = (predicate: SQL | undefined) => {
  if (!predicate) throw new Error("No where clause was captured");
  return renderSql(predicate);
};

type FakeClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
  release: ReturnType<typeof vi.fn>;
};

const fakePg = ({ roundTripMs = 0 }: { roundTripMs?: number } = {}) => {
  const held = new Map<number, number>();
  const checkedOut: FakeClient[] = [];
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
    const { sql: text, params } = renderSql(query);
    const connection = idle[nextIdle++ % idle.length];
    return run(connection, text, params);
  });

  return { held, checkedOut };
};

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

    expect(stuckTriggerCutoff().toISOString()).toBe("2026-08-30T10:55:00.000Z");
  });

  it("tracks TRIGGER_PER_RUN_TIMEOUT_MS", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
    process.env.TRIGGER_PER_RUN_TIMEOUT_MS = String(2 * 60 * 60 * 1000);

    expect(stuckTriggerCutoff().toISOString()).toBe("2026-08-30T09:55:00.000Z");
  });
});

describe("recoverStuckChats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails `running` Chats whose run heartbeat has gone stale", async () => {
    const { updates } = captureUpdates([{ id: "chat-1" }]);

    await recoverStuckChats();

    const captured = updates[0];
    expect(captured.table).toBe(chatTable);
    expect(captured.set).toMatchObject({ status: "failed" });

    const { sql: text, params } = render(captured.where);
    expect(text).toBe(
      `("chat"."status" = $1 and "chat"."run_heartbeat_at" < $2)`,
    );
    expect(params).toEqual(["running", "2026-08-30T11:59:00.000Z"]);
  });

  it("does not wait out a long Chat per-run timeout", async () => {
    vi.stubEnv("CHAT_PER_RUN_TIMEOUT_MS", String(2 * 60 * 60 * 1000));
    const { updates } = captureUpdates([]);

    await recoverStuckChats();
    vi.unstubAllEnvs();

    expect(render(updates[0].where).params[1]).toBe("2026-08-30T11:59:00.000Z");
  });

  it("logs the sweep at warn with the row count and cutoff", async () => {
    captureUpdates([{ id: "chat-1" }, { id: "chat-2" }]);

    await recoverStuckChats();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        count: 2,
        cutoff: "2026-08-30T11:59:00.000Z",
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

describe("recoverStuckTriggers", () => {
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

  it("fails `running` rows past the per-run timeout plus the buffer, and `pending` rows past the buffer alone", async () => {
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
      `(("trigger_run"."status" = $1 and "trigger_run"."started_at" < $2) or ` +
        `("trigger_run"."status" = $3 and "trigger_run"."started_at" < $4))`,
    );
    expect(params).toEqual([
      "running",
      "2026-08-30T10:25:00.000Z",
      "pending",
      "2026-08-30T11:55:00.000Z",
    ]);
  });

  it("closes the orphaned runs' still-open events as errors, with no duration", async () => {
    const { updates } = captureUpdates([
      { runId: "run-1", triggerId: "t1" },
      { runId: "run-2", triggerId: "t2" },
    ]);

    await recoverStuckTriggers();

    expect(updates.map((c) => c.table)).toEqual([
      triggerRunTable,
      triggerRunEventTable,
    ]);
    const events = updates[1];
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

  it("announces each run it failed, once", async () => {
    const orphans = [
      {
        runId: "run-1",
        triggerId: "t1",
        status: "failed",
        errorMessage: "Server restarted during execution",
      },
      {
        runId: "run-2",
        triggerId: "t2",
        status: "failed",
        errorMessage: "Server restarted during execution",
      },
    ];
    captureUpdates(orphans);

    await recoverStuckTriggers();

    expect(mockAnnounce).toHaveBeenCalledTimes(1);
    expect(mockAnnounce).toHaveBeenCalledWith(orphans);
  });

  it("announces nothing when no run was orphaned", async () => {
    captureUpdates([]);

    await recoverStuckTriggers();

    expect(mockAnnounce).not.toHaveBeenCalled();
  });
});

describe("sweepTokenRemindersIfDue", () => {
  const HOUR = 60 * 60 * 1000;
  const T0 = new Date("2026-08-30T12:00:00.000Z").getTime();

  beforeEach(() => {
    vi.clearAllMocks();
    resetTokenReminderSweep();
    mockSendReminders.mockResolvedValue(undefined);
    mockSendA2aReminders.mockResolvedValue(undefined);
  });

  it("sweeps at most once an hour: the reminders' thresholds are days", async () => {
    await sweepTokenRemindersIfDue(T0);
    await sweepTokenRemindersIfDue(T0 + HOUR - 1);
    expect(mockSendReminders).toHaveBeenCalledTimes(1);
    expect(mockSendReminders).toHaveBeenCalledWith(new Date(T0));
    expect(mockSendA2aReminders).toHaveBeenCalledTimes(1);
    expect(mockSendA2aReminders).toHaveBeenCalledWith(new Date(T0));

    await sweepTokenRemindersIfDue(T0 + HOUR);
    expect(mockSendReminders).toHaveBeenCalledTimes(2);
  });

  it("tries again on the next tick after a sweep that failed", async () => {
    mockSendReminders.mockRejectedValueOnce(new Error("db down"));

    await expect(sweepTokenRemindersIfDue(T0)).rejects.toThrow("db down");
    await sweepTokenRemindersIfDue(T0 + 60_000);
    expect(mockSendReminders).toHaveBeenCalledTimes(2);
  });
});

describe("scheduleAligned", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:20.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("stops the schedule when its stop handle is called", async () => {
    const job = vi.fn(takesTime);

    const stop = scheduleAligned("test", 60_000, job);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(job).toHaveBeenCalledTimes(1);

    stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(job).toHaveBeenCalledTimes(1);
  });

  it("a tick already running when stopped is not rescheduled", async () => {
    const job = vi.fn(async () => {
      await takesTime();
    });

    const stop = scheduleAligned("test", 60_000, job);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(job).toHaveBeenCalledTimes(1);

    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(job).toHaveBeenCalledTimes(1);
  });
});

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
    pg = fakePg({ roundTripMs: 5 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  let pg: ReturnType<typeof fakePg>;

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

    startScheduler();
    startScheduler();

    await vi.advanceTimersByTimeAsync(1_050);
    expect(mockFireTrigger).toHaveBeenCalledTimes(1);
    expect(sweepTimes).toEqual(["09:00"]);

    await vi.advanceTimersByTimeAsync(30 * 60_000);
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
