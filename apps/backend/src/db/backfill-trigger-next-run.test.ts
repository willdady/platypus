import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedDb, resetMockDb } from "../test-utils.ts";
import { db } from "../index.ts";
import { backfillTriggerNextRunAt } from "./backfill-trigger-next-run.ts";

/**
 * The v4 upgrade step's seam: a table of Triggers in, the same table with
 * every stranded schedule filled in. Evaluated through the same in-memory
 * fake the routes' tests use, so the `WHERE` the backfill writes is honoured
 * rather than asserted on as a string.
 */
const hourly = {
  cronExpression: "0 * * * *",
  timezone: "UTC",
  isOneOff: false,
};

const trigger = (over: Record<string, unknown>) => ({
  workspaceId: "ws-1",
  agentId: "agent-1",
  type: "cron",
  name: "t",
  instruction: "Do it",
  description: "",
  enabled: true,
  nextRunAt: null,
  config: hourly,
  ...over,
});

describe("backfillTriggerNextRunAt", () => {
  beforeEach(() => {
    resetMockDb();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:30.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules an enabled cron Trigger whose next run is missing", async () => {
    const fake = seedDb({ trigger: [trigger({ id: "stranded" })] });
    const now = new Date("2026-08-30T12:00:30.000Z");

    const result = await backfillTriggerNextRunAt(db, now);

    expect(result).toEqual({ scheduled: 1, skipped: 0 });
    expect(fake.tables.trigger[0]).toMatchObject({
      nextRunAt: new Date("2026-08-30T13:00:00.000Z"),
      updatedAt: now,
    });
  });

  // A firing disables a One-off, so an enabled one with no schedule never
  // ran: this is the firing it was waiting for.
  it("schedules an enabled One-off that never fired", async () => {
    const fake = seedDb({
      trigger: [trigger({ id: "once", config: { ...hourly, isOneOff: true } })],
    });

    expect(await backfillTriggerNextRunAt(db)).toEqual({
      scheduled: 1,
      skipped: 0,
    });
    expect(fake.tables.trigger[0]?.nextRunAt).toEqual(
      new Date("2026-08-30T13:00:00.000Z"),
    );
  });

  it("leaves a Trigger that already has a schedule alone", async () => {
    const scheduled = new Date("2026-08-30T12:30:00.000Z");
    const fake = seedDb({
      trigger: [trigger({ id: "fine", nextRunAt: scheduled })],
    });

    expect(await backfillTriggerNextRunAt(db)).toEqual({
      scheduled: 0,
      skipped: 0,
    });
    expect(fake.tables.trigger[0]?.nextRunAt).toEqual(scheduled);
  });

  it.each([
    ["a disabled Trigger", { enabled: false }],
    [
      "an event Trigger",
      { type: "event", config: { events: ["card.updated"] } },
    ],
  ])("leaves %s alone", async (_label, over) => {
    const fake = seedDb({ trigger: [trigger({ id: "other", ...over })] });

    expect(await backfillTriggerNextRunAt(db)).toEqual({
      scheduled: 0,
      skipped: 0,
    });
    expect(fake.tables.trigger[0]?.nextRunAt).toBeNull();
  });

  it("skips a Trigger whose cron config cannot be parsed", async () => {
    const fake = seedDb({
      trigger: [trigger({ id: "broken", config: { cronExpression: "nope" } })],
    });

    expect(await backfillTriggerNextRunAt(db)).toEqual({
      scheduled: 0,
      skipped: 1,
    });
    expect(fake.tables.trigger[0]?.nextRunAt).toBeNull();
  });
});
