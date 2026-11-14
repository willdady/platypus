import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { asDb, resetMockDb, mockDb, seedDb, type Row } from "../test-utils.ts";
import { inArray, lte, notInArray } from "drizzle-orm";
import { db, type Tx } from "../index.ts";
import { mockLogger, mockNanoid } from "../test-setup.ts";
import { triggerRun as triggerRunTable } from "../db/schema.ts";
import type { EventTriggerEventPayload } from "@platypus/schemas";

const { mockAnnounce, mockDeletePrefix } = vi.hoisted(() => ({
  mockAnnounce: vi.fn(),
  mockDeletePrefix: vi.fn<(prefix: string) => Promise<void>>(),
}));

// The announcement is a delivery detail with its own tests; the lifecycle's
// contract is *which* rows it hands over, and that it hands over only the ones
// a write changed.
vi.mock("./trigger-run-announce.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./trigger-run-announce.ts")>()),
  announceTriggerRunsEnded: mockAnnounce,
}));

vi.mock("../storage/index.ts", () => ({
  getStorage: () => ({ deletePrefix: mockDeletePrefix }),
}));

import {
  acceptInboundTriggerRun,
  adoptPendingTriggerRun,
  cancelPendingTriggerRuns,
  endTriggerRun,
  failAbandonedTriggerRuns,
  failUnstartedTriggerRun,
  LIVE_TRIGGER_RUN_STATUSES,
  liveTriggerRun,
  notLiveTriggerRun,
  openTriggerRun,
  recordSuppressedTriggerRun,
  retainTriggerRuns,
  suppressTriggerRun,
  triggerRunsEnded,
  type EndTriggerRunInput,
} from "./trigger-run-lifecycle.ts";

const NOW = new Date("2026-01-01T12:00:00Z");
// A partial payload: these tests check it is stored as given, not its shape.
const cardData = { id: "card-1" } as EventTriggerEventPayload["data"];

/** The run's row as the seeded fake has it, after a write. */
const runRow = (fake: { tables: Record<string, Row[]> }, id = "run-1") =>
  fake.tables.trigger_run.find((run) => run.id === id);

/** The Trigger and its Workspace, as retention needs to read them. */
const seededWorld = (rows: { runs?: Row[]; events?: Row[] } = {}) =>
  seedDb({
    trigger: [
      {
        id: "trigger-1",
        workspaceId: "ws-1",
        maxRunsToKeep: 10,
      },
    ],
    workspace: [{ id: "ws-1", organizationId: "org-1" }],
    trigger_run: rows.runs ?? [],
    trigger_run_event: rows.events ?? [],
  });

/** Ends `run-1` with `over` folded into a minimal terminal write. */
const end = (over: Partial<EndTriggerRunInput> = {}) =>
  endTriggerRun({
    runId: "run-1",
    status: "succeeded",
    stats: {},
    eventsTruncated: false,
    failedToolCalls: 0,
    ...over,
  });

describe("the live-status predicate", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  it("is `pending` or `running`, and nothing else", () => {
    expect(LIVE_TRIGGER_RUN_STATUSES).toEqual(["pending", "running"]);
  });

  it("spells a live run as the same two statuses for a reader", () => {
    liveTriggerRun();
    notLiveTriggerRun();

    expect(vi.mocked(inArray)).toHaveBeenCalledWith(triggerRunTable.status, [
      "pending",
      "running",
    ]);
    expect(vi.mocked(notInArray)).toHaveBeenCalledWith(triggerRunTable.status, [
      "pending",
      "running",
    ]);
  });
});

describe("openTriggerRun", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  it("inserts a triggerRun row with status running and event metadata", async () => {
    await openTriggerRun(asDb<Tx>(mockDb), {
      runId: "run-1",
      triggerId: "trigger-1",
      eventType: "card.created",
      eventData: cardData,
    });

    expect(mockDb.insert).toHaveBeenCalledTimes(1);
    const inserted = mockDb.values.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.id).toBe("run-1");
    expect(inserted.triggerId).toBe("trigger-1");
    expect(inserted.status).toBe("running");
    expect(inserted.entityId).toBeNull();
    expect(inserted.eventType).toBe("card.created");
    expect(inserted.eventData).toEqual({ id: "card-1" });
    expect(inserted.startedAt).toBeInstanceOf(Date);
    expect(inserted.createdAt).toBeInstanceOf(Date);
  });

  it("stores the event's entity so the run-rate breaker can count per record", async () => {
    await openTriggerRun(asDb<Tx>(mockDb), {
      runId: "run-1",
      triggerId: "trigger-1",
      entityId: "card-1",
      eventType: "card.updated",
      eventData: cardData,
    });

    const inserted = mockDb.values.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.entityId).toBe("card-1");
  });

  it("inserts a row with null event metadata when no event context is provided", async () => {
    await openTriggerRun(asDb<Tx>(mockDb), {
      runId: "run-1",
      triggerId: "trigger-1",
    });

    const inserted = mockDb.values.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.eventType).toBeNull();
    expect(inserted.eventData).toBeNull();
  });
});

describe("adoptPendingTriggerRun", () => {
  beforeEach(() => {
    resetMockDb();
  });

  it("moves the pending row to running and stamps the real start", async () => {
    const fake = seedDb({
      trigger_run: [
        {
          id: "run-1",
          triggerId: "trigger-1",
          status: "pending",
          startedAt: new Date(NOW.getTime() - 60_000),
        },
      ],
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);

    await db.transaction((tx: Tx) => adoptPendingTriggerRun(tx, "run-1"));

    expect(runRow(fake)).toMatchObject({
      status: "running",
      startedAt: NOW,
    });
  });

  it("fails and leaves the row as it was when the run is no longer pending", async () => {
    const swept = {
      id: "run-1",
      triggerId: "trigger-1",
      status: "failed",
      errorMessage: "Server restarted during execution",
      completedAt: new Date(NOW.getTime() - 30_000),
      startedAt: new Date(NOW.getTime() - 60_000),
    };
    const fake = seedDb({ trigger_run: [swept] });

    await expect(
      db.transaction((tx: Tx) => adoptPendingTriggerRun(tx, "run-1")),
    ).rejects.toThrow("is no longer pending; not started");

    expect(runRow(fake)).toEqual(swept);
  });
});

describe("acceptInboundTriggerRun", () => {
  beforeEach(() => {
    resetMockDb();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes a pending row carrying the record and the call's inputs", async () => {
    const fake = seedDb({ trigger_run: [] });

    await db.transaction((tx: Tx) =>
      acceptInboundTriggerRun(tx, {
        runId: "run-1",
        triggerId: "trigger-1",
        entityId: "PLAT-42",
        inputs: { issueKey: "PLAT-42" },
      }),
    );

    expect(runRow(fake)).toMatchObject({
      id: "run-1",
      triggerId: "trigger-1",
      status: "pending",
      entityId: "PLAT-42",
      eventType: null,
      eventData: { inputs: { issueKey: "PLAT-42" } },
      startedAt: NOW,
    });
    expect(mockAnnounce).not.toHaveBeenCalled();
  });
});

describe("endTriggerRun", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    // The chainable mock resolves `.returning()` to whatever a test stubs; an
    // empty page means "no row changed", so nothing is announced.
    mockDb.returning.mockResolvedValue([]);
  });

  it("maps a succeeded run to status 'success' with stats", async () => {
    await end({
      stats: {
        steps: 2,
        toolCalls: [{ name: "tool1", count: 3 }],
        inputTokens: 100,
        outputTokens: 50,
      },
    });

    expect(mockDb.update).toHaveBeenCalledTimes(1);
    const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg.status).toBe("success");
    expect(setArg.errorMessage).toBeNull();
    expect(setArg.stats).toEqual({
      steps: 2,
      toolCalls: [{ name: "tool1", count: 3 }],
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(setArg.completedAt).toBeInstanceOf(Date);
  });

  // Issue #446 / ADR-0018: an Operator reading the runs page can see a
  // scheduled Agent heading for the limit only if the figure is recorded.
  it("persists Context occupancy alongside the unchanged token sums", async () => {
    await end({
      stats: {
        steps: 4,
        toolCalls: [{ name: "tool1", count: 3 }],
        inputTokens: 100,
        outputTokens: 50,
        contextOccupancy: 42,
      },
    });

    const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg.stats).toEqual({
      steps: 4,
      toolCalls: [{ name: "tool1", count: 3 }],
      inputTokens: 100,
      outputTokens: 50,
      contextOccupancy: 42,
    });
  });

  it("omits occupancy for a Provider that reported no usage", async () => {
    await end({
      stats: { steps: 1, toolCalls: [], inputTokens: 0, outputTokens: 0 },
    });

    const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
    // Absent, not 0: a zero would read as a measurement of an empty context.
    expect(setArg.stats).not.toHaveProperty("contextOccupancy");
  });

  // Issue #734. The cached-input breakdown is a spread, the same idiom as
  // occupancy: absent means the Provider reported no cache detail, never a 0.
  it("persists the cached-input breakdown alongside the unchanged token sums", async () => {
    await end({
      stats: {
        steps: 4,
        toolCalls: [{ name: "tool1", count: 3 }],
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 900,
        cacheWriteTokens: 0,
      },
    });

    const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg.stats).toEqual({
      steps: 4,
      toolCalls: [{ name: "tool1", count: 3 }],
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 900,
      cacheWriteTokens: 0,
    });
  });

  it("persists the per-model breakdown of the token sums", async () => {
    const usageByModel = [
      { providerId: "p1", model: "big", inputTokens: 70, outputTokens: 40 },
      { providerId: "p2", model: "small", inputTokens: 30, outputTokens: 10 },
    ];

    await end({
      stats: {
        steps: 2,
        toolCalls: [],
        inputTokens: 100,
        outputTokens: 50,
        usageByModel,
      },
    });

    const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg.stats).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
      usageByModel,
    });
  });

  it("omits the cache fields for a run whose Provider reported none", async () => {
    await end({
      stats: { steps: 1, toolCalls: [], inputTokens: 10, outputTokens: 5 },
    });

    const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
    // A real reported write of 0 above was kept — here neither key exists at
    // all because the Provider never reported a cache detail.
    expect(setArg.stats).not.toHaveProperty("cacheReadTokens");
    expect(setArg.stats).not.toHaveProperty("cacheWriteTokens");
  });

  it("persists the Fallback switch marker on the run's stats", async () => {
    const fallback = {
      from: { providerId: "p1", model: "m1" },
      to: { providerId: "p2", model: "m2" },
    };

    await end({
      stats: {
        steps: 1,
        toolCalls: [],
        inputTokens: 10,
        outputTokens: 5,
        fallback,
      },
    });

    const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg.stats).toMatchObject({ fallback });
  });

  it("maps a failed run to status 'failed' with the error message", async () => {
    await end({ status: "failed", error: new Error("Model exploded") });

    const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg.status).toBe("failed");
    expect(setArg.errorMessage).toBe("Model exploded");
    expect(setArg.stats).toBeNull();
    expect(setArg.completedAt).toBeInstanceOf(Date);
  });

  // #647: a run cancelled at 40 seconds used to land as a failed run with no
  // error, indistinguishable from a crash on the detail page.
  it("records a cancelled run as 'cancelled', not 'failed'", async () => {
    await end({ status: "cancelled" });

    const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg.status).toBe("cancelled");
    expect(setArg.errorMessage).toBeNull();
  });

  it("persists the final assistant text on the run", async () => {
    await end({ finalText: "Three cards moved to Done." });

    const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg.finalText).toBe("Three cards moved to Done.");
    expect(setArg.eventsTruncated).toBe(false);
  });

  it("stores no final text for a run that never produced one", async () => {
    await end({ status: "failed", error: new Error("Model exploded") });

    const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg.finalText).toBeNull();
  });

  it("stores no stats for a run that never observed a step", async () => {
    await end();

    const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg.stats).toBeNull();
  });

  // Without this the run lands as a plain 'success' and nothing anywhere says
  // the answer was cut off at the model's ceiling.
  it("persists the truncation marker on a run that hit the output limit", async () => {
    await end({
      stats: {
        steps: 1,
        toolCalls: [],
        inputTokens: 100,
        outputTokens: 4096,
        truncatedByTokenLimit: true,
      },
    });

    const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg.status).toBe("success");
    expect(setArg.stats).toEqual({
      steps: 1,
      toolCalls: [],
      inputTokens: 100,
      outputTokens: 4096,
      truncatedByTokenLimit: true,
    });
  });

  it("omits the marker entirely for a run that finished cleanly", async () => {
    await end({
      stats: { steps: 1, toolCalls: [], inputTokens: 1, outputTokens: 1 },
    });

    const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg.stats).not.toHaveProperty("truncatedByTokenLimit");
  });

  // Issue #540. The run history page reads the persisted stats, so a run that
  // ended at its step ceiling is only distinguishable from one the Agent
  // finished if the flag is written here.
  it("persists the step-limit marker on a run whose loop was stopped short", async () => {
    await end({
      stats: {
        steps: 15,
        toolCalls: [],
        inputTokens: 100,
        outputTokens: 200,
        stoppedAtStepLimit: true,
      },
    });

    const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
    // Still a success: the run did the work it was allowed to do.
    expect(setArg.status).toBe("success");
    expect(setArg.stats).toEqual({
      steps: 15,
      toolCalls: [],
      inputTokens: 100,
      outputTokens: 200,
      stoppedAtStepLimit: true,
    });
  });

  it("omits the step-limit marker for a run that finished cleanly", async () => {
    await end({
      stats: { steps: 1, toolCalls: [], inputTokens: 1, outputTokens: 1 },
    });

    const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg.stats).not.toHaveProperty("stoppedAtStepLimit");
  });

  it("carries the Run timeline's truncation and failed-tool-call markers (#1184)", async () => {
    await end({ eventsTruncated: true, failedToolCalls: 2 });

    const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg.eventsTruncated).toBe(true);
    expect(setArg.failedToolCalls).toBe(2);
  });
});

describe("a run's end", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDeletePrefix.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("announces the run it ended, once", async () => {
    const startedAt = new Date("2026-01-01T00:00:00Z");
    seedDb({
      trigger_run: [
        {
          id: "run-1",
          triggerId: "trigger-1",
          status: "running",
          startedAt,
          completedAt: null,
          errorMessage: null,
        },
      ],
    });

    await end({ status: "failed", error: new Error("Run timed out") });

    expect(mockAnnounce).toHaveBeenCalledTimes(1);
    expect(mockAnnounce).toHaveBeenCalledWith([
      expect.objectContaining({
        runId: "run-1",
        triggerId: "trigger-1",
        status: "failed",
        errorMessage: "Run timed out",
        startedAt,
      }),
    ]);
  });

  it("changes nothing and announces nothing when the run has already ended", async () => {
    const ended = {
      id: "run-1",
      triggerId: "trigger-1",
      status: "success",
      startedAt: new Date("2026-01-01T00:00:00Z"),
      completedAt: new Date("2026-01-01T00:01:00Z"),
      errorMessage: null,
      finalText: "Done",
    };
    const fake = seedDb({ trigger_run: [ended] });

    await end({ status: "failed", error: new Error("late finish") });

    expect(runRow(fake)).toEqual(ended);
    expect(mockAnnounce).not.toHaveBeenCalled();
  });

  it("leaves a run the recovery sweep already failed untouched, and announces nothing", async () => {
    const swept = {
      id: "run-1",
      triggerId: "trigger-1",
      status: "failed",
      startedAt: new Date("2026-01-01T00:00:00Z"),
      completedAt: new Date("2026-01-01T00:30:00Z"),
      errorMessage: "Server restarted during execution",
    };
    const fake = seedDb({ trigger_run: [swept] });

    await end({ status: "failed", error: new Error("Run timed out") });

    expect(runRow(fake)).toEqual(swept);
    expect(mockAnnounce).not.toHaveBeenCalled();
  });

  it("announces nothing for a run whose row is gone (its Trigger was deleted)", async () => {
    seedDb({ trigger_run: [] });

    await end();

    expect(mockAnnounce).not.toHaveBeenCalled();
  });

  it("prunes the ended run's Trigger history once the write has landed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    vi.stubEnv("TRIGGER_BREAKER_WINDOW_SECONDS", "3600");
    const longAgo = new Date("2026-01-01T09:00:00Z");
    const fake = seedDb({
      trigger: [{ id: "trigger-1", workspaceId: "ws-1", maxRunsToKeep: 1 }],
      workspace: [{ id: "ws-1", organizationId: "org-1" }],
      trigger_run: [
        {
          id: "run-1",
          triggerId: "trigger-1",
          status: "running",
          startedAt: new Date("2026-01-01T11:59:00Z"),
        },
        {
          id: "run-old",
          triggerId: "trigger-1",
          status: "success",
          startedAt: longAgo,
          completedAt: longAgo,
        },
      ],
    });

    await end();

    // The run that just ended is the newest, so the budget keeps it and prunes
    // the row outside the breaker window.
    expect(fake.tables.trigger_run.map((run) => run.id)).toEqual(["run-1"]);
  });
});

describe("failUnstartedTriggerRun", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  it("fails a pending run with the firing's error and announces it", async () => {
    const fake = seedDb({
      trigger_run: [
        {
          id: "run-1",
          triggerId: "trigger-1",
          status: "pending",
          startedAt: NOW,
        },
      ],
    });

    await failUnstartedTriggerRun("run-1", new Error("Workspace not found"));

    expect(runRow(fake)).toMatchObject({
      status: "failed",
      errorMessage: "Workspace not found",
    });
    expect(runRow(fake)?.completedAt).toBeInstanceOf(Date);
    expect(mockAnnounce).toHaveBeenCalledWith([
      expect.objectContaining({ runId: "run-1", status: "failed" }),
    ]);
  });

  it("leaves a run its Drive already adopted alone", async () => {
    const running = {
      id: "run-1",
      triggerId: "trigger-1",
      status: "running",
      startedAt: NOW,
      errorMessage: null,
    };
    const fake = seedDb({ trigger_run: [running] });

    await failUnstartedTriggerRun("run-1", new Error("late"));

    expect(runRow(fake)).toEqual(running);
    expect(mockAnnounce).not.toHaveBeenCalled();
  });

  it("logs a write it cannot make instead of rejecting", async () => {
    mockDb.returning.mockRejectedValueOnce(new Error("db down"));

    await expect(
      failUnstartedTriggerRun("run-1", new Error("boom")),
    ).resolves.toBeUndefined();

    expect(mockLogger.error).toHaveBeenCalledWith(
      { runId: "run-1", error: "db down" },
      "Failed to mark a pending inbound trigger run as failed",
    );
  });
});

describe("failAbandonedTriggerRuns", () => {
  const cutoff = new Date("2026-01-01T11:00:00Z");
  const old = new Date("2026-01-01T10:00:00Z");
  const recent = new Date("2026-01-01T11:59:00Z");

  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  it("fails the runs past their cutoff and closes their open events", async () => {
    const fake = seededWorld({
      runs: [
        {
          id: "run-running",
          triggerId: "trigger-1",
          status: "running",
          startedAt: old,
        },
        {
          id: "run-recent",
          triggerId: "trigger-1",
          status: "running",
          startedAt: recent,
        },
        {
          id: "run-done",
          triggerId: "trigger-1",
          status: "success",
          startedAt: old,
        },
      ],
      events: [
        { id: "ev-1", runId: "run-running", seq: 0, status: "running" },
        { id: "ev-2", runId: "run-done", seq: 0, status: "running" },
      ],
    });

    await failAbandonedTriggerRuns({
      runningCutoff: cutoff,
      pendingCutoff: cutoff,
    });

    expect(runRow(fake, "run-running")).toMatchObject({
      status: "failed",
      errorMessage: "Server restarted during execution",
    });
    expect(runRow(fake, "run-recent")?.status).toBe("running");
    expect(runRow(fake, "run-done")?.status).toBe("success");
    // No terminal run leaves an open event behind; a finished run's events are
    // already closed by whoever finished it.
    expect(fake.tables.trigger_run_event).toEqual([
      expect.objectContaining({ id: "ev-1", status: "error" }),
      expect.objectContaining({ id: "ev-2", status: "running" }),
    ]);
    expect(mockAnnounce).toHaveBeenCalledWith([
      expect.objectContaining({ runId: "run-running", status: "failed" }),
    ]);
  });

  it("gives a pending run its own, shorter cutoff", async () => {
    const fake = seededWorld({
      runs: [
        {
          id: "run-pending",
          triggerId: "trigger-1",
          status: "pending",
          startedAt: old,
        },
      ],
    });

    // Past the pending cutoff but not the running one: an accepted call whose
    // process died between answering and starting it.
    await failAbandonedTriggerRuns({
      runningCutoff: new Date("2026-01-01T09:00:00Z"),
      pendingCutoff: new Date("2026-01-01T10:30:00Z"),
    });

    expect(runRow(fake, "run-pending")?.status).toBe("failed");
  });

  it("is not revived or re-announced by a late finish", async () => {
    const fake = seededWorld({
      runs: [
        {
          id: "run-1",
          triggerId: "trigger-1",
          status: "running",
          startedAt: old,
          errorMessage: null,
        },
      ],
      events: [{ id: "ev-1", runId: "run-1", seq: 0, status: "running" }],
    });

    await failAbandonedTriggerRuns({
      runningCutoff: cutoff,
      pendingCutoff: cutoff,
    });
    // The run's sink finishes after the sweep took it.
    await end({ status: "succeeded" });

    expect(runRow(fake, "run-1")).toMatchObject({
      status: "failed",
      errorMessage: "Server restarted during execution",
    });
    expect(fake.tables.trigger_run_event[0]).toMatchObject({ status: "error" });
    expect(mockAnnounce).toHaveBeenCalledTimes(1);
    expect(mockAnnounce).toHaveBeenCalledWith([
      expect.objectContaining({ runId: "run-1", status: "failed" }),
    ]);
  });

  it("touches nothing when no run was abandoned", async () => {
    const fake = seededWorld({
      runs: [
        {
          id: "run-1",
          triggerId: "trigger-1",
          status: "running",
          startedAt: recent,
        },
      ],
    });

    await failAbandonedTriggerRuns({
      runningCutoff: cutoff,
      pendingCutoff: cutoff,
    });

    expect(fake.queries.filter((q) => q.kind === "update")).toHaveLength(1);
    expect(mockAnnounce).not.toHaveBeenCalled();
  });
});

describe("suppression", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockNanoid.mockReturnValue("run-suppressed");
    mockDeletePrefix.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("writes a suppressed row carrying the entity and the event", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const fake = seededWorld();

    await suppressTriggerRun({
      triggerId: "trigger-1",
      entityId: "card-1",
      eventType: "card.updated",
      eventData: cardData,
    });

    expect(runRow(fake, "run-suppressed")).toMatchObject({
      id: "run-suppressed",
      triggerId: "trigger-1",
      status: "suppressed",
      entityId: "card-1",
      eventType: "card.updated",
      eventData: { id: "card-1" },
      startedAt: NOW,
      createdAt: NOW,
    });
  });

  it("announces the row it wrote", async () => {
    seededWorld();

    await suppressTriggerRun({
      triggerId: "trigger-1",
      entityId: "card-1",
      eventType: "card.updated",
      eventData: cardData,
    });

    expect(mockAnnounce).toHaveBeenCalledTimes(1);
    expect(mockAnnounce).toHaveBeenCalledWith([
      expect.objectContaining({
        runId: "run-suppressed",
        status: "suppressed",
      }),
    ]);
  });

  it("trims the Trigger's history with the row it just wrote", async () => {
    // A runaway produces suppressed rows fast; recording one without retention
    // would let the evidence of the trip fill the table.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    // Outside the breaker window, so maxRunsToKeep is what prunes them.
    const old = (n: number) => new Date(NOW.getTime() - n * 60 * 60_000);
    const fake = seedDb({
      trigger: [{ id: "trigger-1", workspaceId: "ws-1", maxRunsToKeep: 2 }],
      workspace: [{ id: "ws-1", organizationId: "org-1" }],
      trigger_run: [
        {
          id: "run-1",
          triggerId: "trigger-1",
          status: "success",
          startedAt: old(1),
        },
        {
          id: "run-2",
          triggerId: "trigger-1",
          status: "success",
          startedAt: old(2),
        },
        {
          id: "run-3",
          triggerId: "trigger-1",
          status: "success",
          startedAt: old(3),
        },
      ],
    });

    await suppressTriggerRun({
      triggerId: "trigger-1",
      entityId: "card-1",
      eventType: "card.updated",
      eventData: cardData,
    });

    expect(
      fake.tables.trigger_run
        .filter((run) => run.status !== "suppressed")
        .map((run) => run.id),
    ).toEqual(["run-1", "run-2"]);
  });

  it("budgets suppressed rows separately from the runs they displaced", async () => {
    vi.stubEnv("TRIGGER_BREAKER_SUPPRESSED_RUNS_TO_KEEP", "2");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const old = (n: number) => new Date(NOW.getTime() - n * 60_000);
    const fake = seedDb({
      trigger: [{ id: "trigger-1", workspaceId: "ws-1", maxRunsToKeep: 10 }],
      workspace: [{ id: "ws-1", organizationId: "org-1" }],
      trigger_run: [
        {
          id: "sup-1",
          triggerId: "trigger-1",
          status: "suppressed",
          startedAt: old(1),
        },
        {
          id: "sup-2",
          triggerId: "trigger-1",
          status: "suppressed",
          startedAt: old(2),
        },
        {
          id: "run-1",
          triggerId: "trigger-1",
          status: "success",
          startedAt: old(3),
        },
      ],
    });

    await suppressTriggerRun({
      triggerId: "trigger-1",
      entityId: "card-1",
      eventType: "card.updated",
      eventData: cardData,
    });

    // The row just written and the newest old one; the run is untouched.
    expect(
      fake.tables.trigger_run
        .filter((run) => run.status === "suppressed")
        .map((run) => run.id)
        .sort(),
    ).toEqual(["run-suppressed", "sup-1"]);
    expect(runRow(fake, "run-1")).toBeDefined();
  });

  it("prunes with the file scope, so a pruned run's stored files go too", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const fake = seedDb({
      trigger: [{ id: "trigger-1", workspaceId: "ws-1", maxRunsToKeep: 1 }],
      workspace: [{ id: "ws-1", organizationId: "org-1" }],
      trigger_run: [
        {
          id: "run-old",
          triggerId: "trigger-1",
          status: "success",
          startedAt: new Date(NOW.getTime() - 3 * 60 * 60 * 1000),
        },
        {
          id: "run-new",
          triggerId: "trigger-1",
          status: "success",
          startedAt: new Date(NOW.getTime() - 60_000),
        },
      ],
    });

    await suppressTriggerRun({
      triggerId: "trigger-1",
      entityId: "card-1",
      eventType: "card.updated",
      eventData: cardData,
    });

    expect(
      fake.tables.trigger_run
        .filter((run) => run.status !== "suppressed")
        .map((run) => run.id),
    ).toEqual(["run-new"]);
    expect(mockDeletePrefix.mock.calls.map(([prefix]) => prefix)).toEqual([
      "org-1/ws-1/run-old/",
    ]);
  });

  it("announces nothing and leaves no row when the recording transaction rolls back", async () => {
    const fake = seededWorld();

    await expect(
      db.transaction(async (tx: Tx) => {
        await recordSuppressedTriggerRun(tx, {
          runId: "run-suppressed",
          triggerId: "trigger-1",
          entityId: "card-1",
          eventData: { inputs: {} },
        });
        // Never settled: the caller's transaction has not committed, and the
        // announcement it owes dies with the rollback.
        throw new Error("the acceptance decision rolled back");
      }),
    ).rejects.toThrow("the acceptance decision rolled back");

    expect(runRow(fake, "run-suppressed")).toBeUndefined();
    expect(mockAnnounce).not.toHaveBeenCalled();
  });
});

describe("cancelPendingTriggerRuns", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  it("ends every pending run of the Triggers, and nothing else", async () => {
    const fake = seedDb({
      trigger_run: [
        {
          id: "run-pending",
          triggerId: "t-1",
          status: "pending",
          startedAt: NOW,
        },
        {
          id: "run-running",
          triggerId: "t-1",
          status: "running",
          startedAt: NOW,
        },
        { id: "run-done", triggerId: "t-1", status: "success", startedAt: NOW },
        {
          id: "run-elsewhere",
          triggerId: "t-2",
          status: "pending",
          startedAt: NOW,
        },
      ],
    });

    const ended = await db.transaction((tx: Tx) =>
      cancelPendingTriggerRuns(tx, ["t-1"]),
    );

    expect(ended.map((run) => run.runId)).toEqual(["run-pending"]);
    expect(runRow(fake, "run-pending")?.status).toBe("cancelled");
    expect(runRow(fake, "run-running")?.status).toBe("running");
    expect(runRow(fake, "run-elsewhere")?.status).toBe("pending");
    // Nothing is announced from inside the transaction that wrote it.
    expect(mockAnnounce).not.toHaveBeenCalled();

    await triggerRunsEnded(ended);

    expect(mockAnnounce).toHaveBeenCalledTimes(1);
    expect(mockAnnounce).toHaveBeenCalledWith([
      expect.objectContaining({ runId: "run-pending", status: "cancelled" }),
    ]);
  });
});

describe("retainTriggerRuns", () => {
  /**
   * The retention queries in call order: the newest normal rows, the normal
   * rows inside the breaker window, the newest suppressed rows — then one
   * delete per budget whose result the caller reads through `.returning`.
   */
  const stubRetention = ({
    newest,
    suppressed,
    deleted = [],
    deletedSuppressed = [],
  }: {
    newest: { id: string }[];
    suppressed: { id: string }[];
    deleted?: { id: string }[];
    deletedSuppressed?: { id: string }[];
  }) => {
    mockDb.limit
      .mockResolvedValueOnce(newest)
      .mockResolvedValueOnce(suppressed);
    mockDb.returning
      .mockResolvedValueOnce(deleted)
      .mockResolvedValueOnce(deletedSuppressed);
  };

  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDeletePrefix.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("keeps every run inside the breaker window, however small maxRunsToKeep is", async () => {
    // The floor the breaker's count depends on: maxRunsToKeep alone would have
    // deleted the in-window rows before the count could see them. They are
    // spared by predicate rather than by id, so the delete cannot grow an id
    // list with the Trigger's throughput.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    vi.stubEnv("TRIGGER_BREAKER_WINDOW_SECONDS", "3600");
    stubRetention({ newest: [{ id: "newest" }], suppressed: [] });

    await retainTriggerRuns("trigger-1", 1);

    expect(vi.mocked(lte)).toHaveBeenCalledWith(
      triggerRunTable.startedAt,
      new Date("2026-01-01T11:00:00Z"),
    );
  });

  it("carries no more ids into the delete than maxRunsToKeep", async () => {
    // The regression this guards: the kept set used to be the union of the
    // newest page and every row inside the window, so a Trigger firing across
    // many entities built an unbounded `notInArray` argument on a query that
    // runs after every run.
    stubRetention({
      newest: [{ id: "newest" }, { id: "newer" }],
      suppressed: [],
    });

    await retainTriggerRuns("trigger-1", 2);

    expect(vi.mocked(notInArray)).toHaveBeenCalledWith(triggerRunTable.id, [
      "newest",
      "newer",
    ]);
    // Two selects only — the newest page and the suppressed page. A third
    // would be the window scan this replaced.
    expect(mockDb.select).toHaveBeenCalledTimes(2);
  });

  it("derives the kept window from the configured breaker window", async () => {
    // The floor is the Operator's window, read at runtime: a test pinned to a
    // module constant could not cover a value set at deploy time.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    vi.stubEnv("TRIGGER_BREAKER_WINDOW_SECONDS", "60");
    stubRetention({ newest: [{ id: "newest" }], suppressed: [] });

    await retainTriggerRuns("trigger-1", 1);

    expect(vi.mocked(lte)).toHaveBeenCalledWith(
      triggerRunTable.startedAt,
      new Date("2026-01-01T11:59:00Z"),
    );
  });

  it("budgets suppressed rows separately from maxRunsToKeep", async () => {
    vi.stubEnv("TRIGGER_BREAKER_SUPPRESSED_RUNS_TO_KEEP", "1");
    stubRetention({
      newest: [{ id: "newest" }],
      suppressed: [{ id: "suppressed-newest" }],
    });

    await retainTriggerRuns("trigger-1", 1);

    expect(vi.mocked(notInArray)).toHaveBeenCalledWith(triggerRunTable.id, [
      "suppressed-newest",
    ]);
  });

  it("never prunes a run still in flight, however old", async () => {
    // A per-run timeout longer than the breaker window would otherwise delete a
    // live run's row: its sink would finish nothing, and an Inbound Trigger's
    // dedup and poll would lose it mid-run.
    stubRetention({ newest: [{ id: "newest" }], suppressed: [] });

    await retainTriggerRuns("trigger-1", 1);

    expect(vi.mocked(notInArray)).toHaveBeenCalledWith(triggerRunTable.status, [
      "pending",
      "running",
    ]);
  });

  it("does not prune when the Trigger holds fewer rows than either budget", async () => {
    // A short page from either budget means it returned every row there is.
    mockDb.limit.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await retainTriggerRuns("trigger-1", 10);

    expect(mockDb.delete).not.toHaveBeenCalled();
  });

  it("still budgets suppressed rows when maxRunsToKeep is zero", async () => {
    vi.stubEnv("TRIGGER_BREAKER_SUPPRESSED_RUNS_TO_KEEP", "1");
    mockDb.limit.mockResolvedValueOnce([{ id: "suppressed-newest" }]);
    mockDb.returning.mockResolvedValueOnce([]);

    await retainTriggerRuns("trigger-1", 0);

    expect(vi.mocked(notInArray)).toHaveBeenCalledWith(triggerRunTable.id, [
      "suppressed-newest",
    ]);
  });

  it("deletes the stored files under each pruned run Chat's prefix", async () => {
    // A run's Chat id is the run id, so each deleted run row names a storage
    // prefix nothing else reaches once the row is gone.
    stubRetention({
      newest: [{ id: "newest" }],
      suppressed: [],
      deleted: [{ id: "run-1" }, { id: "run-2" }],
    });

    await retainTriggerRuns("trigger-1", 1, {
      orgId: "org-1",
      workspaceId: "ws-1",
    });

    expect(
      mockDeletePrefix.mock.calls.map(([prefix]) => prefix).sort(),
    ).toEqual(["org-1/ws-1/run-1/", "org-1/ws-1/run-2/"]);
  });

  it("logs a storage failure without failing the prune", async () => {
    stubRetention({
      newest: [{ id: "newest" }],
      suppressed: [],
      deleted: [{ id: "run-1" }],
    });
    mockDeletePrefix.mockRejectedValue(new Error("storage down"));

    await expect(
      retainTriggerRuns("trigger-1", 1, {
        orgId: "org-1",
        workspaceId: "ws-1",
      }),
    ).resolves.toBeUndefined();

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: "org-1/ws-1/run-1/" }),
      "Failed to delete files from storage",
    );
  });

  it("logs a failed scope lookup without failing the prune", async () => {
    // Retention has already committed its delete when the fallback lookup runs.
    // Losing the scope must cost the files, not the prune.
    stubRetention({
      newest: [{ id: "newest" }],
      suppressed: [],
      deleted: [{ id: "run-1" }],
    });
    mockDb.limit.mockRejectedValueOnce(new Error("database down"));

    await expect(retainTriggerRuns("trigger-1", 1)).resolves.toBeUndefined();

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ triggerId: "trigger-1" }),
      "Failed to resolve a Trigger's scope for run file deletion",
    );
    expect(mockDeletePrefix).not.toHaveBeenCalled();
  });
});

/**
 * The acceptance criteria this feature is measured by are about the shape of
 * the production source, not any one behaviour, so they are pinned by reading
 * it: a status write that appears in a second module is the bug the lifecycle
 * exists to prevent.
 */
describe("the lifecycle's monopoly", () => {
  const sourceRoot = fileURLToPath(new URL("../", import.meta.url));

  const productionSources = (): { file: string; text: string }[] => {
    const files: { file: string; text: string }[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.name.endsWith(".ts") || entry.name.includes(".test.")) {
          continue;
        }
        if (entry.name.endsWith(".test-fixtures.ts")) continue;
        files.push({ file: path, text: readFileSync(path, "utf8") });
      }
    };
    walk(sourceRoot);
    return files;
  };

  const sources = productionSources();
  const lifecycle = join(sourceRoot, "services/trigger-run-lifecycle.ts");
  const announce = join(sourceRoot, "services/trigger-run-announce.ts");

  it("is the only production module that writes a Trigger run's status", () => {
    // Every insert names a status, so an insert is a status write. An update
    // is one only when its `set` carries a status: the sink still writes the
    // mid-run stats and the unloaded Tool sets. Deletes are not: a row deleted
    // by cascade with its Trigger, and the bulk history delete a transfer may
    // make, are exempt.
    const writesStatus = (text: string): boolean => {
      if (/\.insert\(\s*triggerRunTable\b/.test(text)) return true;
      for (const statement of text.matchAll(
        /\.update\(\s*triggerRunTable\b[\s\S]*?\.where\(/g,
      )) {
        if (/\bstatus\s*:/.test(statement[0])) return true;
      }
      return false;
    };

    const writers = sources
      .filter(({ text }) => writesStatus(text))
      .map(({ file }) => file);

    expect(writers).toEqual([lifecycle]);
  });

  it("is the only production module that imports the announcement or retention", () => {
    const users = sources
      .filter(({ file }) => file !== lifecycle && file !== announce)
      .filter(({ text }) =>
        /announceTriggerRunsEnded|endedTriggerRunColumns|retainTriggerRuns/.test(
          text,
        ),
      )
      .map(({ file }) => file);

    expect(users).toEqual([]);
  });

  it("defines the pending/running predicate once", () => {
    // A live run spelled out again — the pair in one array, `inArray`, or SQL —
    // is the duplication the shared predicate exists to remove.
    const schema = join(sourceRoot, "db/schema.ts");
    const restatements = sources
      // The column's check constraint names every status the column may hold;
      // that is the vocabulary, not a reader deciding whether a run is live.
      .filter(({ file }) => file !== lifecycle && file !== schema)
      .filter(({ text }) =>
        /\[\s*["']pending["']\s*,\s*["']running["']\s*\]|['"]pending['"],\s*['"]running['"]/.test(
          text,
        ),
      )
      .map(({ file }) => file);

    expect(restatements).toEqual([]);
  });

  it("keeps the internal names out of every other module's imports", () => {
    const declarations = ["announceTriggerRunsEnded", "endedTriggerRunColumns"];
    const importers = sources
      .filter(({ file }) => file !== lifecycle && file !== announce)
      .filter(({ text }) =>
        declarations.some((name) =>
          new RegExp(`import[\\s\\S]*\\b${name}\\b[\\s\\S]*?from`).test(text),
        ),
      )
      .map(({ file }) => file);

    expect(importers).toEqual([]);
  });
});
