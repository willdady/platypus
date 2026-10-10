import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockDb, resetMockDb, seedDb } from "../../test-utils.ts";

const { mockAnnounce } = vi.hoisted(() => ({ mockAnnounce: vi.fn() }));

vi.mock("../../services/trigger-run-announce.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../services/trigger-run-announce.ts")
  >()),
  announceTriggerRunsEnded: mockAnnounce,
}));

import { TriggerSink } from "./trigger-sink.ts";
import { RunEventRecorder } from "../run-events.ts";
import { mockLogger } from "../../test-setup.ts";
import {
  triggerRun as triggerRunTable,
  triggerRunEvent as triggerRunEventTable,
} from "../../db/schema.ts";
import type { ResolvedRunPlan } from "../types.ts";

/** Every `.set()` payload, paired with the table its `.update()` targeted. */
const updates = () =>
  mockDb.update.mock.calls.map((call, i) => ({
    table: call[0],
    set: mockDb.set.mock.calls[i]?.[0] as Record<string, unknown>,
  }));

/** Every `.values()` payload, paired with the table its `.insert()` targeted. */
const inserts = () =>
  mockDb.insert.mock.calls.map((call, i) => ({
    table: call[0],
    values: mockDb.values.mock.calls[i]?.[0],
  }));

const eventRows = () =>
  inserts()
    .filter((i) => i.table === triggerRunEventTable)
    .map((i) => i.values as Array<Record<string, unknown>>);

const plan: ResolvedRunPlan = {
  resolved: {
    agentId: "a1",
    providerId: "p1",
    modelId: "m1",
  },
};

const owner = { workspaceId: "ws-1", ownerId: "user-1" };

describe("TriggerSink", () => {
  beforeEach(() => {
    resetMockDb();
    // The Workspace still has the Owner the run was resolved to act as.
    mockDb.for.mockResolvedValue([{ id: "ws-1" }]);
  });

  describe("onStart", () => {
    it("inserts a triggerRun row with status running and event metadata", async () => {
      const sink = new TriggerSink({
        ...owner,
        triggerId: "trigger-1",
        eventType: "card.created",
        eventData: { cardId: "c1" },
      });

      await sink.onStart({ runId: "run-1", messages: [] });

      expect(mockDb.insert).toHaveBeenCalledTimes(1);
      const inserted = mockDb.values.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(inserted.id).toBe("run-1");
      expect(inserted.triggerId).toBe("trigger-1");
      expect(inserted.status).toBe("running");
      expect(inserted.entityId).toBeNull();
      expect(inserted.eventType).toBe("card.created");
      expect(inserted.eventData).toEqual({ cardId: "c1" });
      expect(inserted.startedAt).toBeInstanceOf(Date);
      expect(inserted.createdAt).toBeInstanceOf(Date);
    });

    it("stores the event's entity so the run-rate breaker can count per record", async () => {
      const sink = new TriggerSink({
        ...owner,
        triggerId: "trigger-1",
        entityId: "card-1",
        eventType: "card.updated",
        eventData: { id: "card-1" },
      });

      await sink.onStart({ runId: "run-1", messages: [] });

      const inserted = mockDb.values.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(inserted.entityId).toBe("card-1");
    });

    it("inserts a row with null event metadata when no event context is provided", async () => {
      const sink = new TriggerSink({ ...owner, triggerId: "trigger-1" });

      await sink.onStart({ runId: "run-1", messages: [] });

      const inserted = mockDb.values.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(inserted.eventType).toBeNull();
      expect(inserted.eventData).toBeNull();
    });
  });

  it("starts nothing once the Workspace has a different Owner", async () => {
    mockDb.for.mockResolvedValueOnce([]);
    const sink = new TriggerSink({ ...owner, triggerId: "trigger-1" });

    await expect(
      sink.onStart({ runId: "run-1", messages: [] }),
    ).rejects.toThrow("no longer has the Owner");

    // Read under a share lock, which a transfer's update lock waits on.
    expect(mockDb.for).toHaveBeenCalledWith("share");
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  describe("onResolved", () => {
    it("does not touch the DB when every Tool set loaded", async () => {
      const sink = new TriggerSink({ ...owner, triggerId: "trigger-1" });

      await sink.onResolved({ runId: "run-1", plan });
      await sink.onResolved({
        runId: "run-1",
        plan: { ...plan, unloadedToolSets: [] },
      });

      expect(mockDb.update).not.toHaveBeenCalled();
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    // Written before the model is called, so a run that fails on its first
    // step still says which tools it never had (#1184).
    it("records the Tool sets that loaded no tools on the run row", async () => {
      const sink = new TriggerSink({ ...owner, triggerId: "trigger-1" });
      const unloadedToolSets = [
        { toolSetId: "mcp-1", name: "Jira", reason: "unreachable" as const },
      ];

      await sink.onResolved({
        runId: "run-1",
        plan: { ...plan, unloadedToolSets },
      });

      expect(updates()).toEqual([
        { table: triggerRunTable, set: { unloadedToolSets } },
      ]);
    });
  });

  describe("onProgress + FlushScheduler", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("writes incremental stats to the triggerRun row on the flush interval", async () => {
      const sink = new TriggerSink({
        ...owner,
        triggerId: "trigger-1",
        flushIntervalMs: 100,
      });
      await sink.onStart({ runId: "run-1", messages: [] });
      await sink.onResolved({ runId: "run-1", plan });

      // Multiple bumps within the window — coalesce to one write
      await sink.onProgress({
        runId: "run-1",
        messages: [],
        stats: {
          steps: 1,
          toolCalls: [{ name: "t1", count: 1 }],
          inputTokens: 10,
          outputTokens: 5,
        },
      });
      await sink.onProgress({
        runId: "run-1",
        messages: [],
        stats: {
          steps: 2,
          toolCalls: [{ name: "t1", count: 2 }],
          inputTokens: 20,
          outputTokens: 10,
        },
      });

      expect(mockDb.update).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);

      expect(mockDb.update).toHaveBeenCalledTimes(1);
      const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.stats).toEqual({
        steps: 2,
        toolCalls: [{ name: "t1", count: 2 }],
        inputTokens: 20,
        outputTokens: 10,
      });
      // No status flip on incremental writes — terminal status is for onFinish
      expect(setArg.status).toBeUndefined();
    });

    it("does not write when no steps have been observed yet", async () => {
      const sink = new TriggerSink({
        ...owner,
        triggerId: "trigger-1",
        flushIntervalMs: 100,
      });
      await sink.onStart({ runId: "run-1", messages: [] });
      await sink.onProgress({ runId: "run-1", messages: [], stats: {} });
      await vi.advanceTimersByTimeAsync(200);

      // No update call — stats with steps==null are skipped
      expect(mockDb.update).not.toHaveBeenCalled();
    });
  });

  describe("onFinish", () => {
    it("maps a succeeded run to status 'success' with stats", async () => {
      const sink = new TriggerSink({ ...owner, triggerId: "trigger-1" });

      await sink.onFinish({
        runId: "run-1",
        status: "succeeded",
        messages: [],
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
      const sink = new TriggerSink({ ...owner, triggerId: "trigger-1" });

      await sink.onFinish({
        runId: "run-1",
        status: "succeeded",
        messages: [],
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
      const sink = new TriggerSink({ ...owner, triggerId: "trigger-1" });

      await sink.onFinish({
        runId: "run-1",
        status: "succeeded",
        messages: [],
        stats: { steps: 1, toolCalls: [], inputTokens: 0, outputTokens: 0 },
      });

      const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
      // Absent, not 0: a zero would read as a measurement of an empty context.
      expect(setArg.stats).not.toHaveProperty("contextOccupancy");
    });

    // Issue #734. The cached-input breakdown is a spread, the same idiom as
    // occupancy: absent means the Provider reported no cache detail, never a 0.
    it("persists the cached-input breakdown alongside the unchanged token sums", async () => {
      const sink = new TriggerSink({ ...owner, triggerId: "trigger-1" });

      await sink.onFinish({
        runId: "run-1",
        status: "succeeded",
        messages: [],
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

    it("omits the cache fields for a run whose Provider reported none", async () => {
      const sink = new TriggerSink({ ...owner, triggerId: "trigger-1" });

      await sink.onFinish({
        runId: "run-1",
        status: "succeeded",
        messages: [],
        stats: { steps: 1, toolCalls: [], inputTokens: 10, outputTokens: 5 },
      });

      const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
      // A real reported write of 0 above was kept — here neither key exists at
      // all because the Provider never reported a cache detail.
      expect(setArg.stats).not.toHaveProperty("cacheReadTokens");
      expect(setArg.stats).not.toHaveProperty("cacheWriteTokens");
    });

    it("maps a failed run to status 'failed' with the error message", async () => {
      const sink = new TriggerSink({ ...owner, triggerId: "trigger-1" });

      await sink.onFinish({
        runId: "run-1",
        status: "failed",
        messages: [],
        stats: {},
        error: new Error("Model exploded"),
      });

      const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.status).toBe("failed");
      expect(setArg.errorMessage).toBe("Model exploded");
      expect(setArg.stats).toBeNull();
      expect(setArg.completedAt).toBeInstanceOf(Date);
    });

    // #647: a run cancelled at 40 seconds used to land as a failed run with no
    // error, indistinguishable from a crash on the detail page.
    it("records a cancelled run as 'cancelled', not 'failed'", async () => {
      const sink = new TriggerSink({ ...owner, triggerId: "trigger-1" });

      await sink.onFinish({
        runId: "run-1",
        status: "cancelled",
        messages: [],
        stats: {},
      });

      const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.status).toBe("cancelled");
      expect(setArg.errorMessage).toBeNull();
    });

    it("persists the final assistant text on the run", async () => {
      const sink = new TriggerSink({ ...owner, triggerId: "trigger-1" });

      await sink.onFinish({
        runId: "run-1",
        status: "succeeded",
        messages: [],
        stats: {},
        finalText: "Three cards moved to Done.",
      });

      const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.finalText).toBe("Three cards moved to Done.");
      expect(setArg.eventsTruncated).toBe(false);
    });

    it("stores no final text for a run that never produced one", async () => {
      const sink = new TriggerSink({ ...owner, triggerId: "trigger-1" });

      await sink.onFinish({
        runId: "run-1",
        status: "failed",
        messages: [],
        stats: {},
        error: new Error("Model exploded"),
      });

      const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.finalText).toBeNull();
    });

    it("only writes stats when steps are present (succeeded with no stats yields null)", async () => {
      const sink = new TriggerSink({ ...owner, triggerId: "trigger-1" });

      await sink.onFinish({
        runId: "run-1",
        status: "succeeded",
        messages: [],
        stats: {},
      });

      const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.stats).toBeNull();
    });

    // Without this the run lands as a plain 'success' and nothing anywhere says
    // the answer was cut off at the model's ceiling.
    it("persists the truncation marker on a run that hit the output limit", async () => {
      const sink = new TriggerSink({ ...owner, triggerId: "trigger-1" });

      await sink.onFinish({
        runId: "run-1",
        status: "succeeded",
        messages: [],
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
      const sink = new TriggerSink({ ...owner, triggerId: "trigger-1" });

      await sink.onFinish({
        runId: "run-1",
        status: "succeeded",
        messages: [],
        stats: { steps: 1, toolCalls: [], inputTokens: 1, outputTokens: 1 },
      });

      const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.stats).not.toHaveProperty("truncatedByTokenLimit");
    });

    // Issue #540. The run history page reads the persisted stats, so a run that
    // ended at its step ceiling is only distinguishable from one the Agent
    // finished if the flag is written here.
    it("persists the step-limit marker on a run whose loop was stopped short", async () => {
      const sink = new TriggerSink({ ...owner, triggerId: "trigger-1" });

      await sink.onFinish({
        runId: "run-1",
        status: "succeeded",
        messages: [],
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
      const sink = new TriggerSink({ ...owner, triggerId: "trigger-1" });

      await sink.onFinish({
        runId: "run-1",
        status: "succeeded",
        messages: [],
        stats: { steps: 1, toolCalls: [], inputTokens: 1, outputTokens: 1 },
      });

      const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.stats).not.toHaveProperty("stoppedAtStepLimit");
    });
  });
});

describe("TriggerSink terminal announcement", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  const startedAt = new Date("2026-01-01T00:00:00Z");
  const runRow = (status: string) => ({
    id: "run-1",
    triggerId: "trigger-1",
    status,
    eventType: null,
    eventData: null,
    entityId: null,
    startedAt,
    completedAt: null,
    errorMessage: null,
    stats: null,
    finalText: null,
    eventsTruncated: false,
    createdAt: startedAt,
  });

  const finish = (sink: TriggerSink) =>
    sink.onFinish({
      runId: "run-1",
      status: "failed",
      messages: [],
      stats: {},
      error: new Error("Run timed out"),
      finalText: "late answer",
    });

  it("announces the run it ended, once", async () => {
    seedDb({ trigger_run: [runRow("running")] });

    await finish(new TriggerSink({ ...owner, triggerId: "trigger-1" }));

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

  it("leaves a run the recovery sweep already failed untouched, and announces nothing", async () => {
    const swept = {
      ...runRow("failed"),
      errorMessage: "Server restarted during execution",
      completedAt: new Date("2026-01-01T00:30:00Z"),
    };
    const db = seedDb({ trigger_run: [swept] });

    await finish(new TriggerSink({ ...owner, triggerId: "trigger-1" }));

    expect(db.tables.trigger_run).toEqual([swept]);
    expect(mockAnnounce).not.toHaveBeenCalled();
  });

  it("announces nothing for a run whose row is gone (its Trigger was deleted)", async () => {
    seedDb({ trigger_run: [] });

    await finish(new TriggerSink({ ...owner, triggerId: "trigger-1" }));

    expect(mockAnnounce).not.toHaveBeenCalled();
  });
});

/**
 * The Run timeline's durable half (#647). The recorder decides an event's
 * shape; the sink decides when rows land — batched on the flush interval,
 * inserted once and patched after — and that no terminal run leaves an event
 * open.
 */
describe("TriggerSink run events", () => {
  beforeEach(() => {
    resetMockDb();
    mockDb.for.mockResolvedValue([{ id: "ws-1" }]);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const startWithEvents = async (flushIntervalMs = 100) => {
    const sink = new TriggerSink({
      ...owner,
      triggerId: "trigger-1",
      flushIntervalMs,
    });
    const events = new RunEventRecorder({ runId: "run-1" });
    await sink.onStart({ runId: "run-1", messages: [], events });
    return { sink, events };
  };

  it("writes the events recorded since the last flush as one multi-row insert", async () => {
    const { events } = await startWithEvents();

    const a = events.open(null, { type: "tool-call", toolName: "search" });
    events.open(null, { type: "text" });
    events.close(a!, { status: "completed" });

    expect(eventRows()).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);

    expect(eventRows()).toHaveLength(1);
    const [batch] = eventRows();
    expect(batch.map((row) => [row.type, row.status])).toEqual([
      ["tool-call", "completed"],
      ["text", "running"],
    ]);
    expect(batch[0]).toMatchObject({
      runId: "run-1",
      parentEventId: null,
      seq: 0,
      toolName: "search",
    });
    expect(typeof batch[0].startedAt).toBe("number");
  });

  it("patches an already-written event when it later closes, without re-inserting it", async () => {
    const { events } = await startWithEvents();
    const id = events.open(null, { type: "text" });
    await vi.advanceTimersByTimeAsync(100);
    expect(eventRows()).toHaveLength(1);

    events.close(id!, { status: "error", error: "boom" });
    await vi.advanceTimersByTimeAsync(100);

    expect(eventRows()).toHaveLength(1);
    const patch = updates().find((u) => u.table === triggerRunEventTable);
    expect(patch?.set).toMatchObject({
      status: "error",
      error: { message: "boom", truncated: false, originalBytes: 4 },
    });
    expect(typeof patch?.set.durationMs).toBe("number");
  });

  it("writes nothing while no event has been recorded", async () => {
    await startWithEvents();
    await vi.advanceTimersByTimeAsync(300);

    expect(eventRows()).toEqual([]);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("closes still-open events with the run's terminal status before the terminal row is written", async () => {
    const { sink, events } = await startWithEvents();
    events.open(null, { type: "tool-call", toolName: "slow" });

    await sink.onFinish({
      runId: "run-1",
      status: "cancelled",
      messages: [],
      stats: {},
    });

    // The event landed cancelled, in the terminal batch, before the run row
    // flipped — so no poller sees a terminal run with a running event.
    expect(eventRows()).toHaveLength(1);
    expect(eventRows()[0][0]).toMatchObject({
      status: "cancelled",
      toolName: "slow",
    });
    expect(typeof eventRows()[0][0].durationMs).toBe("number");
    const eventInsertAt = mockDb.insert.mock.invocationCallOrder.at(-1)!;
    const rowUpdateAt = mockDb.update.mock.invocationCallOrder.at(-1)!;
    expect(eventInsertAt).toBeLessThan(rowUpdateAt);

    const row = updates().find((u) => u.table === triggerRunTable);
    expect(row?.set).toMatchObject({ status: "cancelled" });
  });

  it("closes a failed run's open events as errors", async () => {
    const { sink, events } = await startWithEvents();
    events.open(null, { type: "text" });

    await sink.onFinish({
      runId: "run-1",
      status: "failed",
      messages: [],
      stats: {},
      error: new Error("per-run timeout"),
    });

    expect(eventRows()[0][0]).toMatchObject({ status: "error" });
  });

  it("marks the run truncated on the very next flush after the ceiling is hit, not only at the end", async () => {
    const sink = new TriggerSink({
      ...owner,
      triggerId: "trigger-1",
      flushIntervalMs: 100,
    });
    const events = new RunEventRecorder({ runId: "run-1", ceiling: 1 });
    await sink.onStart({ runId: "run-1", messages: [], events });
    events.open(null, { type: "text" });
    events.open(null, { type: "text" });

    await vi.advanceTimersByTimeAsync(100);

    const row = updates().find((u) => u.table === triggerRunTable);
    expect(row?.set).toEqual({ eventsTruncated: true });
  });

  // #1124: the batch was drained before the write, so a transient DB error on a
  // periodic flush dropped those events for good.
  it("keeps a batch whose insert failed and writes every event exactly once by the final flush", async () => {
    const failure = new Error("connection reset");
    const written: string[] = [];
    let failNextEventInsert = true;
    mockDb.values.mockImplementation((rows: unknown) => {
      if (Array.isArray(rows)) {
        if (failNextEventInsert) {
          failNextEventInsert = false;
          throw failure;
        }
        for (const row of rows as Array<{ id: string }>) written.push(row.id);
      }
      return mockDb;
    });
    const { sink, events } = await startWithEvents();

    const a = events.open(null, { type: "tool-call", toolName: "search" });
    const b = events.open(null, { type: "text" });
    await vi.advanceTimersByTimeAsync(100);
    expect(written).toEqual([]);

    const c = events.open(null, { type: "text" });
    await sink.onFinish({
      runId: "run-1",
      status: "succeeded",
      messages: [],
      stats: {},
    });

    expect([...written].sort()).toEqual([a, b, c].sort());
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: failure }),
      expect.any(String),
    );
  });

  it("writes the failed tool call count on the next flush and on finish (#1184)", async () => {
    const { sink, events } = await startWithEvents();
    const a = events.open(null, { type: "tool-call", toolName: "search" });
    events.close(a!, { status: "error", error: "boom" });

    await vi.advanceTimersByTimeAsync(100);
    expect(
      updates().find((u) => u.table === triggerRunTable)?.set,
    ).toMatchObject({ failedToolCalls: 1 });

    const b = events.open(null, { type: "tool-call", toolName: "search" });
    events.close(b!, { status: "error", error: "boom" });
    await sink.onFinish({
      runId: "run-1",
      status: "failed",
      messages: [],
      stats: {},
      error: new Error("model failed"),
    });

    const row = updates()
      .filter((u) => u.table === triggerRunTable)
      .at(-1);
    expect(row?.set).toMatchObject({ status: "failed", failedToolCalls: 2 });
    // The unloaded Tool sets written at resolution are not overwritten.
    expect(row?.set).not.toHaveProperty("unloadedToolSets");
  });

  it("finishes a run with no failed tool calls at zero", async () => {
    const { sink } = await startWithEvents();

    await sink.onFinish({
      runId: "run-1",
      status: "succeeded",
      messages: [],
      stats: {},
    });

    const row = updates().find((u) => u.table === triggerRunTable);
    expect(row?.set).toMatchObject({ failedToolCalls: 0 });
  });

  it("marks the run when its timeline hit the event ceiling", async () => {
    const sink = new TriggerSink({
      ...owner,
      triggerId: "trigger-1",
      flushIntervalMs: 100,
    });
    const events = new RunEventRecorder({ runId: "run-1", ceiling: 1 });
    await sink.onStart({ runId: "run-1", messages: [], events });
    events.open(null, { type: "text" });
    events.open(null, { type: "text" });

    await sink.onFinish({
      runId: "run-1",
      status: "succeeded",
      messages: [],
      stats: {},
    });

    const row = updates().find((u) => u.table === triggerRunTable);
    expect(row?.set).toMatchObject({ eventsTruncated: true });
  });
});
