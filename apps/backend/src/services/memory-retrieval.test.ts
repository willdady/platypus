import { describe, it, expect, beforeEach } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";

import {
  retrieveRecentSummaries,
  formatSummariesForSystemPrompt,
  summaryCutoffForReference,
  resolveMemoryPin,
  MEMORY_SNAPSHOT_RE_PIN_HORIZON_MS,
  MEMORY_SUMMARY_WINDOW_DAYS,
  type MemorySummary,
} from "./memory-retrieval.ts";

const makeSummary = (
  overrides: Partial<MemorySummary> = {},
): MemorySummary => ({
  id: "s1",
  userId: "u1",
  workspaceId: "ws-1",
  summaryDate: "2026-04-29",
  summary: "User likes coffee.",
  embedding: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe("retrieveRecentSummaries", () => {
  beforeEach(() => {
    resetMockDb();
  });

  it("queries the daily summary table ordered by summary_date desc", async () => {
    const rows = [makeSummary()];
    mockDb.orderBy.mockResolvedValueOnce(rows);

    const result = await retrieveRecentSummaries(
      "u1",
      "ws-1",
      new Date("2026-05-03T12:00:00Z"),
    );

    expect(result).toBe(rows);
    expect(mockDb.select).toHaveBeenCalled();
    expect(mockDb.orderBy).toHaveBeenCalled();
  });
});

describe("summaryCutoffForReference", () => {
  it("anchors the cutoff to the reference date, spanning the window back", () => {
    const ref = new Date("2026-05-03T12:00:00Z");
    expect(summaryCutoffForReference(ref, 2)).toBe("2026-05-01");
  });

  it("counts a forward reference crossing (the midnight drift that used to roll every Chat)", () => {
    const ref = new Date("2026-05-03T23:59:59Z");
    const nextDay = new Date("2026-05-04T00:00:00Z");
    // Different references → different cutoffs, but the reference is an INPUT:
    // two turns anchoring to the same moment resolve identically.
    expect(summaryCutoffForReference(ref, 2)).toBe("2026-05-01");
    expect(summaryCutoffForReference(nextDay, 2)).toBe("2026-05-02");
  });

  it("spans MEMORY_SUMMARY_WINDOW_DAYS back for the window the code actually ships", () => {
    const ref = new Date("2026-05-03T12:00:00Z");
    expect(summaryCutoffForReference(ref, MEMORY_SUMMARY_WINDOW_DAYS)).toBe(
      "2026-05-01",
    );
  });
});

describe("resolveMemoryPin", () => {
  const now = new Date("2026-05-03T12:00:00Z");

  it("re-pins when there is no existing snapshot (new Chat / pre-feature row)", () => {
    expect(
      resolveMemoryPin({
        existingSnapshot: null,
        previousTurnAt: now,
        now,
      }),
    ).toEqual({ reuse: false });
  });

  it("re-pins when there is no recorded previous turn to measure idleness", () => {
    expect(
      resolveMemoryPin({
        existingSnapshot: "block",
        previousTurnAt: null,
        now,
      }),
    ).toEqual({ reuse: false });
  });

  it("keeps the snapshot while the gap since the previous turn is within the horizon", () => {
    const previousTurnAt = new Date(
      now.getTime() - MEMORY_SNAPSHOT_RE_PIN_HORIZON_MS + 1,
    );
    expect(
      resolveMemoryPin({
        existingSnapshot: "block",
        previousTurnAt,
        now,
      }),
    ).toEqual({ reuse: true, block: "block" });
  });

  it("treats a pinned empty block as a valid pin, not an absent one", () => {
    const previousTurnAt = new Date(now.getTime() - 60 * 1000);
    expect(
      resolveMemoryPin({
        existingSnapshot: "",
        previousTurnAt,
        now,
      }),
    ).toEqual({ reuse: true, block: "" });
  });

  it("keeps the snapshot at exactly the horizon boundary", () => {
    const previousTurnAt = new Date(
      now.getTime() - MEMORY_SNAPSHOT_RE_PIN_HORIZON_MS,
    );
    expect(
      resolveMemoryPin({
        existingSnapshot: "block",
        previousTurnAt,
        now,
      }),
    ).toEqual({ reuse: true, block: "block" });
  });

  it("re-pins once the idle gap exceeds the horizon — by which point the cached prefix is provably gone", () => {
    const previousTurnAt = new Date(
      now.getTime() - MEMORY_SNAPSHOT_RE_PIN_HORIZON_MS - 1,
    );
    expect(
      resolveMemoryPin({
        existingSnapshot: "block",
        previousTurnAt,
        now,
      }),
    ).toEqual({ reuse: false });
  });

  it("compares the idle gap, never the snapshot's own age", () => {
    // An eight-hour-old snapshot within an active Chat (short gaps) is kept.
    const previousTurnAt = new Date(now.getTime() - 60 * 1000);
    expect(
      resolveMemoryPin({
        existingSnapshot: "block",
        previousTurnAt,
        now,
      }),
    ).toEqual({ reuse: true, block: "block" });
  });
});

describe("formatSummariesForSystemPrompt", () => {
  it("returns an empty string when there are no summaries", () => {
    expect(formatSummariesForSystemPrompt([])).toBe("");
  });

  it("returns an empty string when all summaries have blank content", () => {
    const summaries = [
      makeSummary({ summary: "" }),
      makeSummary({ summary: "   " }),
    ];
    expect(formatSummariesForSystemPrompt(summaries)).toBe("");
  });

  it("formats summaries with date headings", () => {
    const summaries = [
      makeSummary({ summaryDate: "2026-04-29", summary: "Likes coffee." }),
      makeSummary({ summaryDate: "2026-04-28", summary: "Has a cat." }),
    ];

    const out = formatSummariesForSystemPrompt(summaries);

    expect(out).toContain(
      "Recent memory summaries from previous conversations:",
    );
    expect(out).toContain("### 2026-04-29");
    expect(out).toContain("Likes coffee.");
    expect(out).toContain("### 2026-04-28");
    expect(out).toContain("Has a cat.");
  });

  it("filters out blank summaries while keeping populated ones", () => {
    const summaries = [
      makeSummary({ summaryDate: "2026-04-29", summary: "" }),
      makeSummary({ summaryDate: "2026-04-28", summary: "Has a cat." }),
    ];

    const out = formatSummariesForSystemPrompt(summaries);

    expect(out).not.toContain("2026-04-29");
    expect(out).toContain("### 2026-04-28");
  });
});
