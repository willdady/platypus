import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockDb, resetMockDb } from "../../test-utils.ts";

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
    // A terminal write the lifecycle made changes nothing, so nothing is
    // announced — the announcement belongs to the lifecycle's own tests.
    mockDb.returning.mockResolvedValue([]);
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
