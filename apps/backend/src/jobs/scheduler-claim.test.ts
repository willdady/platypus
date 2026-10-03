import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  vi,
} from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migratedPglite } from "../db/migrated-pglite.test-fixtures.ts";
import {
  trigger as triggerTable,
  triggerRun as triggerRunTable,
} from "../db/schema.ts";

/**
 * The cron claim and the NULL-schedule repair run for real against an
 * in-process Postgres built from the shipped migrations: the behaviour lives in
 * conditional updates, so they are what is exercised. Only the run itself
 * (`fireTrigger`) is stubbed.
 */
const { holder, mockFireTrigger } = vi.hoisted(() => {
  const holder: { db?: ReturnType<typeof drizzle> } = {};
  return { holder, mockFireTrigger: vi.fn() };
});
vi.mock("../index.ts", () => ({
  get db() {
    return holder.db;
  },
}));
vi.mock("../services/trigger-firing.ts", () => ({
  fireTrigger: mockFireTrigger,
}));

const { processDueTriggers, recoverStuckTriggers } =
  await import("./scheduler.ts");

const NOW = new Date("2026-08-30T12:00:30.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const hourly = { cronExpression: "0 * * * *", timezone: "UTC" };

let pg: PGlite;
let db: ReturnType<typeof drizzle>;
beforeAll(async () => {
  pg = await migratedPglite();
  // The Triggers' Workspace and Agent are beside the point; skip the FKs.
  await pg.exec("SET session_replication_role = replica");
  db = drizzle(pg);
  holder.db = db;
}, 60_000);
afterAll(() => pg.close());

beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  mockFireTrigger.mockResolvedValue("ran");
  await pg.exec(`DELETE FROM "trigger_run"; DELETE FROM "trigger";`);
});
afterEach(() => {
  vi.useRealTimers();
});

const seedTrigger = (
  id: string,
  over: Partial<typeof triggerTable.$inferInsert> = {},
) =>
  db.insert(triggerTable).values({
    id,
    workspaceId: "ws-1",
    agentId: "agent-1",
    type: "cron",
    name: id,
    instruction: "Do it",
    config: hourly,
    nextRunAt: minutesAgo(1),
    ...over,
  });

const seedRunning = (triggerId: string, startedAt = minutesAgo(2)) =>
  db.insert(triggerRunTable).values({
    id: `run-${triggerId}`,
    triggerId,
    status: "running",
    startedAt,
  });

const row = async (id: string) => {
  const [r] = await db
    .select()
    .from(triggerTable)
    .where(eq(triggerTable.id, id));
  return r;
};

const firedIds = () =>
  mockFireTrigger.mock.calls.map(([t]) => (t as { id: string }).id).sort();

describe("processDueTriggers", () => {
  it("claims the oldest due Triggers up to the limit, writing each one's next slot", async () => {
    // Newest first, so a claim that ignored age would take the wrong five.
    for (let i = 9; i >= 0; i--) {
      await seedTrigger(`t${i}`, { nextRunAt: minutesAgo(10 - i) });
    }

    await processDueTriggers();

    expect(firedIds()).toEqual(["t0", "t1", "t2", "t3", "t4"]);
    for (let i = 0; i < 5; i++) {
      expect((await row(`t${i}`)).nextRunAt).toEqual(
        new Date("2026-08-30T13:00:00.000Z"),
      );
    }
    // Waiting is not skipping: the rest are untouched, and still due.
    for (let i = 5; i < 10; i++) {
      expect((await row(`t${i}`)).nextRunAt).toEqual(minutesAgo(10 - i));
    }
  });

  it("hands fireTrigger the claimed row, its next schedule already written", async () => {
    await seedTrigger("t1");

    await processDueTriggers();

    expect(mockFireTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "t1",
        nextRunAt: new Date("2026-08-30T13:00:00.000Z"),
      }),
      { kind: "cron" },
    );
  });

  it("claims nothing while the limit's worth of Cron runs are running", async () => {
    for (let i = 0; i < 5; i++) {
      await seedTrigger(`busy${i}`, { nextRunAt: new Date(NOW.getTime() + 1) });
      await seedRunning(`busy${i}`);
    }
    await seedTrigger("t1");

    await processDueTriggers();

    expect(mockFireTrigger).not.toHaveBeenCalled();
    expect((await row("t1")).nextRunAt).toEqual(minutesAgo(1));
  });

  it("does not count Event Trigger runs against the limit", async () => {
    for (let i = 0; i < 4; i++) {
      await seedTrigger(`busy${i}`, { nextRunAt: new Date(NOW.getTime() + 1) });
      await seedRunning(`busy${i}`);
    }
    await seedTrigger("ev", {
      type: "event",
      config: { events: ["card.created"] },
      nextRunAt: null,
    });
    await seedRunning("ev");
    await seedTrigger("t1");

    await processDueTriggers();

    expect(firedIds()).toEqual(["t1"]);
  });

  it("disables a one-off at claim", async () => {
    await seedTrigger("once", { config: { ...hourly, isOneOff: true } });

    await processDueTriggers();

    expect(firedIds()).toEqual(["once"]);
    expect(await row("once")).toMatchObject({
      enabled: false,
      nextRunAt: null,
    });
  });

  it("skips a firing whose previous run is still going, without taking a slot", async () => {
    await seedTrigger("overlap", { nextRunAt: minutesAgo(30) });
    await seedRunning("overlap");
    for (let i = 0; i < 4; i++) await seedTrigger(`t${i}`);

    await processDueTriggers();

    // One running run leaves four slots; the skip spends none of them.
    expect(firedIds()).toEqual(["t0", "t1", "t2", "t3"]);
    expect((await row("overlap")).nextRunAt).toEqual(
      new Date("2026-08-30T13:00:00.000Z"),
    );
  });

  it("runs a Trigger that waited for a slot once, scheduling from the claim", async () => {
    await seedTrigger("late", {
      config: { cronExpression: "*/5 * * * *", timezone: "UTC" },
      nextRunAt: minutesAgo(20),
    });

    await processDueTriggers();
    await processDueTriggers();

    expect(firedIds()).toEqual(["late"]);
    expect((await row("late")).nextRunAt).toEqual(
      new Date("2026-08-30T12:05:00.000Z"),
    );
  });

  it("fires a Trigger once when two ticks race for it", async () => {
    await seedTrigger("t1");

    await Promise.all([processDueTriggers(), processDueTriggers()]);

    expect(firedIds()).toEqual(["t1"]);
  });

  it("returns without waiting for the runs it started", async () => {
    await seedTrigger("t1");
    mockFireTrigger.mockReturnValue(new Promise(() => {}));

    await processDueTriggers();

    expect(firedIds()).toEqual(["t1"]);
  });

  it("leaves a recurring Trigger whose next slot cannot be computed unclaimed", async () => {
    await seedTrigger("bad", {
      config: { cronExpression: "not a cron", timezone: "UTC" },
    });

    await processDueTriggers();

    expect(mockFireTrigger).not.toHaveBeenCalled();
    expect((await row("bad")).nextRunAt).toEqual(minutesAgo(1));
  });
});

describe("recoverStuckTriggers", () => {
  it("reschedules an enabled recurring Cron Trigger stranded with a NULL nextRunAt", async () => {
    await seedTrigger("stranded", { nextRunAt: null });

    await recoverStuckTriggers();

    expect((await row("stranded")).nextRunAt).toEqual(
      new Date("2026-08-30T13:00:00.000Z"),
    );
  });

  it("reschedules one whose run it just failed as abandoned", async () => {
    await seedTrigger("crashed", { nextRunAt: null });
    await seedRunning("crashed", minutesAgo(120));

    await recoverStuckTriggers();

    expect((await row("crashed")).nextRunAt).toEqual(
      new Date("2026-08-30T13:00:00.000Z"),
    );
  });

  it.each([
    ["one with a live run", "live", {}],
    ["a disabled one", "off", { enabled: false }],
    ["a one-off", "once", { config: { ...hourly, isOneOff: true } }],
  ] as const)("leaves %s alone", async (_label, id, over) => {
    await seedTrigger(id, { nextRunAt: null, ...over });
    if (id === "live") await seedRunning(id);

    await recoverStuckTriggers();

    expect((await row(id)).nextRunAt).toBeNull();
  });
});
