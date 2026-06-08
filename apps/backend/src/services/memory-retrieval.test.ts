import { describe, it, expect, beforeEach } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";

import {
  retrieveRecentSummaries,
  formatSummariesForSystemPrompt,
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

    const result = await retrieveRecentSummaries("u1", "ws-1", 2);

    expect(result).toBe(rows);
    expect(mockDb.select).toHaveBeenCalled();
    expect(mockDb.orderBy).toHaveBeenCalled();
  });

  it("uses a default cutoff of 2 days when not specified", async () => {
    mockDb.orderBy.mockResolvedValueOnce([]);

    await retrieveRecentSummaries("u1", "ws-1");

    expect(mockDb.where).toHaveBeenCalled();
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
