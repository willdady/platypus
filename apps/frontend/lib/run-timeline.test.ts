// @vitest-environment node
import { describe, it, expect } from "vitest";
import type { RunEvent } from "@platypus/schemas";
import {
  barGeometry,
  layoutTimeline,
  mergeRunEvents,
  MIN_BAR_FRACTION,
  nextSinceSeq,
} from "./run-timeline";

const T0 = 1_767_258_000_000;

const event = (over: Partial<RunEvent> & { id: string }): RunEvent => ({
  runId: "run-1",
  parentEventId: null,
  seq: 0,
  type: "tool-call",
  toolName: "search",
  startedAt: T0,
  durationMs: 100,
  status: "completed",
  error: null,
  childrenTruncated: false,
  ...over,
});

describe("layoutTimeline", () => {
  it("orders by start time so parallel tool calls overlap, and rebases once from the earliest start", () => {
    const { rows, originMs, totalMs } = layoutTimeline(
      [
        event({ id: "b", seq: 1, startedAt: T0 + 50, durationMs: 100 }),
        event({ id: "a", seq: 0, startedAt: T0 + 20, durationMs: 200 }),
      ],
      "success",
    );

    expect(originMs).toBe(T0 + 20);
    expect(rows.map((r) => [r.event.id, r.offsetMs])).toEqual([
      ["a", 0],
      ["b", 30],
    ]);
    // The span ends where the last bar ends — a's 200ms, not b's later start.
    expect(totalMs).toBe(200);
  });

  it("nests a delegate's events beneath it, whatever run they came from", () => {
    const { rows } = layoutTimeline(
      [
        event({ id: "d", type: "delegate", toolName: "Researcher", seq: 0 }),
        event({ id: "t", parentEventId: "d", seq: 1, startedAt: T0 + 5 }),
        event({ id: "root-text", type: "text", seq: 2, startedAt: T0 + 300 }),
      ],
      "success",
    );

    expect(rows.map((r) => [r.event.id, r.depth])).toEqual([
      ["d", 0],
      ["t", 1],
      ["root-text", 0],
    ]);
  });

  it("keeps an event whose parent is missing at the root rather than losing it", () => {
    const { rows } = layoutTimeline(
      [event({ id: "orphan", parentEventId: "dropped-at-ceiling" })],
      "success",
    );

    expect(rows.map((r) => [r.event.id, r.depth])).toEqual([["orphan", 0]]);
  });

  it("draws a still-open event under a running run to now", () => {
    const { rows } = layoutTimeline(
      [event({ id: "a", durationMs: null, status: "running" })],
      "running",
      T0 + 750,
    );

    expect(rows[0].end).toEqual({ kind: "running", durationMs: 750 });
  });

  // The sweep closes a crashed run's events without a duration; nothing can
  // say when they ended, so no bar is drawn to "now" or anywhere else.
  it("marks a still-open event under a terminal run as unknown-duration", () => {
    const { rows, totalMs } = layoutTimeline(
      [
        event({ id: "done", durationMs: 400 }),
        event({
          id: "open",
          seq: 1,
          startedAt: T0 + 100,
          durationMs: null,
          status: "error",
        }),
      ],
      "failed",
      T0 + 99_999,
    );

    expect(rows[1].end).toEqual({ kind: "unknown" });
    expect(totalMs).toBe(400);
  });

  it("lays out nothing for a run with no events", () => {
    expect(layoutTimeline([], "success")).toEqual({
      rows: [],
      originMs: 0,
      totalMs: 1,
    });
  });
});

describe("barGeometry", () => {
  it("floors a sub-millisecond span so it stays visible", () => {
    const [row] = layoutTimeline(
      [
        event({ id: "tiny", durationMs: 0 }),
        event({ id: "long", seq: 1, durationMs: 10_000 }),
      ],
      "success",
    ).rows;

    expect(barGeometry(row, 10_000)).toEqual({
      left: 0,
      width: MIN_BAR_FRACTION,
    });
  });

  it("places a bar by its offset and never past the track's end", () => {
    const { rows, totalMs } = layoutTimeline(
      [
        event({ id: "a", durationMs: 100 }),
        event({ id: "b", seq: 1, startedAt: T0 + 75, durationMs: 100 }),
      ],
      "success",
    );

    expect(totalMs).toBe(175);
    const b = barGeometry(rows[1], totalMs);
    expect(b.left).toBeCloseTo(75 / 175);
    expect(b.left + b.width).toBeCloseTo(1);
  });
});

describe("mergeRunEvents", () => {
  it("replaces an event that arrived again patched, and keeps sequence order", () => {
    const existing = [
      event({ id: "a", seq: 0, status: "running", durationMs: null }),
      event({ id: "b", seq: 1 }),
    ];
    const merged = mergeRunEvents(existing, [
      event({ id: "c", seq: 2 }),
      event({ id: "a", seq: 0, status: "completed", durationMs: 90 }),
    ]);

    expect(merged.map((e) => [e.id, e.status])).toEqual([
      ["a", "completed"],
      ["b", "completed"],
      ["c", "completed"],
    ]);
  });

  it("returns the existing list untouched when nothing new arrived", () => {
    const existing = [event({ id: "a" })];
    expect(mergeRunEvents(existing, [])).toBe(existing);
  });
});

describe("nextSinceSeq", () => {
  it("asks for everything when nothing is held", () => {
    expect(nextSinceSeq([])).toBeUndefined();
  });

  it("asks for everything while the very first event is still open", () => {
    expect(
      nextSinceSeq([
        event({ id: "a", seq: 0, status: "running", durationMs: null }),
        event({ id: "b", seq: 1 }),
      ]),
    ).toBeUndefined();
  });

  it("asks from the newest sequence when nothing is running", () => {
    expect(
      nextSinceSeq([event({ id: "a", seq: 0 }), event({ id: "b", seq: 4 })]),
    ).toBe(4);
  });

  // The endpoint filters by sequence number and an event is patched in place
  // when it closes, so asking from the newest event would never see the patch.
  it("asks from just below the oldest still-running event", () => {
    expect(
      nextSinceSeq([
        event({ id: "a", seq: 0 }),
        event({ id: "b", seq: 3, status: "running", durationMs: null }),
        event({ id: "c", seq: 7 }),
      ]),
    ).toBe(2);
  });
});
