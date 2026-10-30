import { describe, expect, it } from "vitest";
import type { PlatypusUIMessage } from "../types.ts";
import {
  applyTranscriptSummary,
  isSummaryUsable,
  lastOccupancyReading,
  projectedOccupancyOf,
  SUMMARY_PART_LABEL,
  summaryAnchorIndex,
  transcriptSummaryBackstopDue,
  transcriptSummaryDueAfterTurn,
  transcriptSummaryKeptTurns,
  type ChatSummaryRow,
} from "./chat-summary.ts";

/**
 * Tests for the pure, send-time half of Transcript summarising (ADR-0041,
 * issue #1716) — the decisions no run around them is needed to pin. The
 * model-calling half (`takeTranscriptSummary`) is exercised through the turn
 * and sink suites, which mock the model the same way the run suites do.
 */

const user = (id: string, text = id): PlatypusUIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

const assistant = (
  id: string,
  extras: PlatypusUIMessage["parts"] = [],
): PlatypusUIMessage => ({
  id,
  role: "assistant",
  parts: [{ type: "text", text: `reply ${id}` }, ...extras],
});

/** A completed `loadSkill` pair — the seeded shape: one part carrying its
 *  input and output under `output-available`. */
const skillPair = (name: string) => [
  {
    type: "tool-loadSkill" as const,
    toolCallId: `call-${name}`,
    state: "output-available" as const,
    input: { name },
    output: { name, body: `body of ${name}` },
  },
];

/** A Chat path: five turns, oldest first. */
const fiveTurns = (): PlatypusUIMessage[] => [
  user("u1"),
  assistant("a1"),
  user("u2"),
  assistant("a2"),
  user("u3"),
  assistant("a3"),
  user("u4"),
  assistant("a4"),
  user("u5"),
  assistant("a5"),
];

const summaryRow = (
  over: Partial<ChatSummaryRow> &
    Pick<ChatSummaryRow, "anchorId" | "coveredIds">,
): ChatSummaryRow => ({
  id: over.anchorId + "-sum",
  chatId: "chat-1",
  text: `summary to ${over.anchorId}`,
  stats: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  ...over,
});

describe("isSummaryUsable", () => {
  it("is usable when its covered ids are exactly the live path to the anchor", () => {
    const path = fiveTurns();
    expect(
      isSummaryUsable(
        summaryRow({ anchorId: "a2", coveredIds: ["u1", "a1", "u2", "a2"] }),
        path,
      ),
    ).toBe(true);
  });

  it("is unusable when a Delete inside the range removed a covered message", () => {
    // u2 is deleted: the live path to a2 skips it.
    const path = fiveTurns().filter((m) => m.id !== "u2");
    expect(
      isSummaryUsable(
        summaryRow({ anchorId: "a2", coveredIds: ["u1", "a1", "u2", "a2"] }),
        path,
      ),
    ).toBe(false);
  });

  it("is unusable when the anchor itself is not on the path", () => {
    // Switching to an Alternative whose path has a different a2: not on path.
    const path = fiveTurns().filter((m) => m.id !== "a2");
    expect(
      isSummaryUsable(
        summaryRow({ anchorId: "a2", coveredIds: ["u1", "a1", "u2", "a2"] }),
        path,
      ),
    ).toBe(false);
  });

  it("stays usable when a Delete lands in the kept tail", () => {
    const path = fiveTurns().filter((m) => m.id !== "u4");
    expect(
      isSummaryUsable(
        summaryRow({ anchorId: "a2", coveredIds: ["u1", "a1", "u2", "a2"] }),
        path,
      ),
    ).toBe(true);
  });
});

describe("applyTranscriptSummary", () => {
  it("applies the deepest usable summary, replacing the covered prefix", () => {
    const path = fiveTurns();
    const deep = summaryRow({
      anchorId: "a4",
      coveredIds: ["u1", "a1", "u2", "a2", "u3", "a3", "u4", "a4"],
    });
    const { messages, summary } = applyTranscriptSummary(path, [deep]);
    expect(summary).toBe(deep);
    // The covered prefix collapses onto the first kept message.
    expect(messages).toHaveLength(2);
    expect(messages[0].id).toBe("u5");
    expect(messages[0].role).toBe("user");
    const firstPart = messages[0].parts[0];
    expect(firstPart.type).toBe("text");
    if (firstPart.type === "text") {
      expect(firstPart.text).toContain(SUMMARY_PART_LABEL);
      expect(firstPart.text).toContain(deep.text);
    }
    // The rest of the kept tail is untouched.
    expect(messages[1].id).toBe("a5");
  });

  it("skips a summary a Delete inside its range made unusable and falls back to an earlier one", () => {
    // u4 is deleted: inside the deep summary's range, outside the shallow's.
    const path = fiveTurns().filter((m) => m.id !== "u4");
    const deep = summaryRow({
      anchorId: "a4",
      coveredIds: ["u1", "a1", "u2", "a2", "u3", "a3", "u4", "a4"],
    });
    const shallow = summaryRow({
      anchorId: "a2",
      coveredIds: ["u1", "a1", "u2", "a2"],
    });
    const { messages, summary } = applyTranscriptSummary(path, [deep, shallow]);
    expect(summary).toBe(shallow);
    // The kept tail begins at the fallback's anchor.
    expect(messages[0].id).toBe("u3");
  });

  it("a Delete of the user that opened the turn after the anchor makes it unusable", () => {
    // u2 is gone: the anchor a1 no longer ends a turn, so the summary has no
    // first kept user message to ride and is skipped.
    const path = fiveTurns().filter((m) => m.id !== "u2");
    const summary = summaryRow({
      anchorId: "a1",
      coveredIds: ["u1", "a1"],
    });
    const { messages, summary: found } = applyTranscriptSummary(path, [
      summary,
    ]);
    expect(found).toBeUndefined();
    expect(messages).toBe(path);
  });

  it("at the same anchor the newest row wins", () => {
    const path = fiveTurns();
    const newer = summaryRow({
      id: "newer",
      anchorId: "a2",
      coveredIds: ["u1", "a1", "u2", "a2"],
      createdAt: new Date("2026-01-02T00:00:00Z"),
    });
    const older = summaryRow({
      id: "older",
      anchorId: "a2",
      coveredIds: ["u1", "a1", "u2", "a2"],
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    // Newest-first, as `loadChatSummaries` returns them.
    const { summary } = applyTranscriptSummary(path, [newer, older]);
    expect(summary?.id).toBe("newer");
  });

  it("returns the path untouched when no summary is usable", () => {
    const path = fiveTurns();
    const offPath = summaryRow({
      anchorId: "a2",
      coveredIds: ["not-on-the-path"],
    });
    const { messages, summary } = applyTranscriptSummary(path, [offPath]);
    expect(summary).toBeUndefined();
    expect(messages).toBe(path);
  });

  it("re-injects each summarised Skill load once, latest load, none the kept tail loads", () => {
    const path = fiveTurns();
    // a1 loads "docs" (earlier) and "ops" (latest of two); a2 loads "docs"
    // again (latest), so "docs" must be a1's load skipped — no: latest wins.
    path[1] = assistant("a1", [...skillPair("docs"), ...skillPair("ops")]);
    path[3] = assistant("a2", skillPair("docs"));
    // a4 (kept tail) loads "ops" again — so re-injection must skip "ops".
    path[7] = assistant("a4", skillPair("ops"));
    // If the kept tail's load were the only load, "ops" would be skipped and
    // "docs" (a2's, the latest) re-injected.
    const summary = summaryRow({
      anchorId: "a2",
      coveredIds: ["u1", "a1", "u2", "a2"],
    });
    const { messages } = applyTranscriptSummary(path, [summary]);
    const textParts = messages[0].parts.filter(
      (part): part is Extract<typeof part, { type: "text" }> =>
        part.type === "text",
    );
    const texts = textParts.map((part) => part.text).join("\n");
    expect(texts).toContain("[Loaded Skill: docs]");
    expect(texts).toContain("body of docs");
    // a1's "ops" load and a4's kept-tail "ops" load both drop out: the kept
    // tail's load serves it, so no re-injection, and the summarised range's
    // version is never a duplicate source.
    expect(texts).not.toContain("[Loaded Skill: ops]");
  });

  it("leaves a summary unread when nothing follows its anchor — it cannot ride a kept user message", () => {
    const path = fiveTurns();
    const leaf = summaryRow({
      anchorId: "a5",
      coveredIds: path.map((m) => m.id),
    });
    const { messages, summary } = applyTranscriptSummary(path, [leaf]);
    expect(summary).toBeUndefined();
    expect(messages).toBe(path);
  });
});

describe("summaryAnchorIndex", () => {
  it("is the assistant before the kept turns, counting from the leaf", () => {
    const path = fiveTurns();
    expect(summaryAnchorIndex(path, 4)).toBe(1); // a1: u2..a5 stay verbatim
    expect(summaryAnchorIndex(path, 1)).toBe(7); // a4: u5+a5 stay verbatim
  });

  it("is undefined when the path does not hold a full tail", () => {
    const path = [user("u1"), assistant("a1"), user("u2"), assistant("a2")];
    expect(summaryAnchorIndex(path, 4)).toBeUndefined();
    // One kept turn: the anchor is a1, the assistant that ends that turn.
    expect(summaryAnchorIndex(path, 1)).toBe(1);
  });

  it("counts a leaf assistant as ending a turn (the seeded loadSkill leaf)", () => {
    const path = [...fiveTurns(), user("u6"), assistant("a-seed")];
    // The seeded leaf is the tail's current assistant: keeping 1 turn means
    // the anchor is a5, preceding the seed's user turn.
    expect(summaryAnchorIndex(path, 1)).toBe(9);
  });
});

describe("the trigger and the backstop", () => {
  it("only ever fires with a declared window and a reading", () => {
    expect(transcriptSummaryDueAfterTurn(8_001, 10_000)).toBe(true);
    expect(transcriptSummaryDueAfterTurn(7_999, 10_000)).toBe(false);
    expect(transcriptSummaryDueAfterTurn(9_000, undefined)).toBe(false);
    expect(transcriptSummaryDueAfterTurn(undefined, 10_000)).toBe(false);
  });

  it("keeps one turn when the trigger reading was taken with a summary", () => {
    expect(transcriptSummaryKeptTurns(undefined)).toBe(4);
    expect(transcriptSummaryKeptTurns("sum-1")).toBe(1);
  });

  describe("transcriptSummaryBackstopDue", () => {
    const path = fiveTurns();
    const usable = summaryRow({
      anchorId: "a2",
      coveredIds: ["u1", "a1", "u2", "a2"],
    });
    const base = {
      projectedOccupancy: 9_600 as number | undefined,
      contextWindow: 10_000 as number | undefined,
      summaries: [] as ChatSummaryRow[],
      path,
    };

    it("is due past the backstop wall with no usable summary", () => {
      expect(
        transcriptSummaryBackstopDue({
          ...base,
          usableSummary: undefined,
          readingSummaryId: undefined,
        }),
      ).toBe(true);
    });

    it("is not due when a usable summary exists", () => {
      expect(
        transcriptSummaryBackstopDue({
          ...base,
          usableSummary: usable,
          readingSummaryId: undefined,
          summaries: [usable],
        }),
      ).toBe(false);
    });

    it("is due for a stale reading after a Delete, beneath the wall", () => {
      // The reading was taken with `usable`; u2 was then deleted, so the
      // summary is no longer usable even though occupancy sits at 0.7.
      const pathAfterDelete = path.filter((m) => m.id !== "u2");
      expect(
        transcriptSummaryBackstopDue({
          ...base,
          projectedOccupancy: 7_000,
          usableSummary: undefined,
          readingSummaryId: usable.id,
          summaries: [usable],
          path: pathAfterDelete,
        }),
      ).toBe(true);
    });

    it("is never due without a declared window or a reading", () => {
      expect(
        transcriptSummaryBackstopDue({
          ...base,
          contextWindow: undefined,
          usableSummary: undefined,
          readingSummaryId: undefined,
        }),
      ).toBe(false);
      expect(
        transcriptSummaryBackstopDue({
          ...base,
          projectedOccupancy: undefined,
          usableSummary: undefined,
          readingSummaryId: undefined,
        }),
      ).toBe(false);
    });
  });
});

describe("lastOccupancyReading / projectedOccupancyOf", () => {
  it("reads the last assistant reading and its summary id", () => {
    const path = fiveTurns();
    path[7] = {
      ...path[7],
      metadata: {
        contextOccupancy: { inputTokens: 900, outputTokens: 90 },
        summaryId: "sum-old",
      },
    };
    const last = lastOccupancyReading(path);
    expect(last).toMatchObject({
      reading: { inputTokens: 900, outputTokens: 90 },
      summaryId: "sum-old",
    });
    expect(projectedOccupancyOf(path)).toMatchObject({
      projected: 990,
      summaryId: "sum-old",
    });
  });

  it("returns nothing when every reading was erased or never reported", () => {
    const path = fiveTurns();
    path[9] = {
      ...path[9],
      metadata: { contextOccupancy: null },
    };
    expect(lastOccupancyReading(path)).toBeUndefined();
  });
});
