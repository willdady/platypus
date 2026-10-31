import { beforeEach, describe, expect, it, vi } from "vitest";
// The fake db (and its mock of `../index.ts`) must be installed before the
// module under test — which opens the db handle — is loaded.
import { resetMockDb, seedDb } from "../test-utils.ts";

// The model call and the model re-resolution are the pass's only I/O. Stub
// them here so the turn verbs can be observed at their own seam: what they
// schedule, what they apply, and how they fail.
const { mockGenerateText, mockResolveGenerationPlan } = vi.hoisted(() => ({
  mockGenerateText: vi.fn(),
  mockResolveGenerationPlan: vi.fn(),
}));
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: mockGenerateText };
});
vi.mock("../runs/agent-plan.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runs/agent-plan.ts")>();
  return { ...actual, resolveGenerationPlan: mockResolveGenerationPlan };
});

import type { PlatypusUIMessage } from "../types.ts";
import {
  afterTurn,
  applyTranscriptSummary,
  beforeTurn,
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
 * issue #1716) and the two turn verbs (`beforeTurn`, `afterTurn`) that
 * sequence it. The model call itself (`takeTranscriptSummary`) is pinned in
 * `chat-summary-pass.test.ts`.
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

    // Issue #1717 (R1): the turn after one the Provider rejected as too long
    // takes a summary first, whatever the reading says — the Provider's own
    // rejection is the measurement, so no window is needed either.
    describe("after a turn that overflowed", () => {
      const overflowedReply = (summaryId?: string): PlatypusUIMessage => ({
        id: "a6",
        role: "assistant",
        parts: [],
        metadata: {
          contextOverflow: true,
          ...(summaryId ? { summaryId } : {}),
        },
      });

      it("is due with no window and no reading", () => {
        expect(
          transcriptSummaryBackstopDue({
            ...base,
            projectedOccupancy: undefined,
            contextWindow: undefined,
            usableSummary: undefined,
            readingSummaryId: undefined,
            path: [...path, overflowedReply(), user("u7")],
          }),
        ).toBe(true);
      });

      it("is due when the only usable summary is the one that overflowed", () => {
        expect(
          transcriptSummaryBackstopDue({
            ...base,
            projectedOccupancy: undefined,
            usableSummary: usable,
            readingSummaryId: undefined,
            summaries: [usable],
            path: [...path, overflowedReply(usable.id), user("u7")],
          }),
        ).toBe(true);
      });

      it("is not due once a summary newer than the overflowed turn's is usable", () => {
        expect(
          transcriptSummaryBackstopDue({
            ...base,
            projectedOccupancy: undefined,
            usableSummary: usable,
            readingSummaryId: undefined,
            summaries: [usable],
            path: [...path, overflowedReply(), user("u7")],
          }),
        ).toBe(false);
      });

      it("is not due for an overflow further back than the last reply", () => {
        expect(
          transcriptSummaryBackstopDue({
            ...base,
            projectedOccupancy: undefined,
            usableSummary: undefined,
            readingSummaryId: undefined,
            path: [
              ...path,
              overflowedReply(),
              user("u7"),
              assistant("a7"),
              user("u8"),
            ],
          }),
        ).toBe(false);
      });
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

// --- The turn verbs ---

const seedSummaryTable = () => seedDb({ chat_summary: [] });

/** Puts a Context occupancy reading on the path's last assistant message. */
const withReading = (
  path: PlatypusUIMessage[],
  inputTokens: number,
  summaryId?: string,
): PlatypusUIMessage[] => {
  const last = path[path.length - 1];
  path[path.length - 1] = {
    ...last,
    metadata: {
      contextOccupancy: { inputTokens, outputTokens: 100 },
      ...(summaryId ? { summaryId } : {}),
    },
  };
  return path;
};

/** Marks the path's last reply as one the Provider rejected as too long. */
const overflowing = (
  path: PlatypusUIMessage[],
  summaryId?: string,
): PlatypusUIMessage[] => {
  const last = path[path.length - 1];
  path[path.length - 1] = {
    ...last,
    metadata: {
      contextOverflow: true,
      ...(summaryId ? { summaryId } : {}),
    },
  };
  return path;
};

const stubPassIO = () => {
  resetMockDb();
  mockGenerateText.mockReset();
  mockGenerateText.mockResolvedValue({
    text: "The summary.",
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  mockResolveGenerationPlan.mockReset();
  mockResolveGenerationPlan.mockResolvedValue({
    plan: { model: {} },
    resolvedModelId: "m1",
  });
};

describe("beforeTurn", () => {
  beforeEach(stubPassIO);

  it("applies the deepest usable summary and reports it, without taking", async () => {
    seedSummaryTable();
    const summary = summaryRow({
      anchorId: "a2",
      coveredIds: ["u1", "a1", "u2", "a2"],
    });

    const result = await beforeTurn({
      path: fiveTurns(),
      summaries: [summary],
      model: {} as never,
      modelId: "m1",
    });

    expect(result.messages[0].id).toBe("u3");
    expect(result.summaryId).toBe(summary.id);
    expect(result.backstopEngaged).toBe(false);
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("waits for and applies a fresh summary when the backstop is due", async () => {
    const fake = seedSummaryTable();
    const path = withReading(fiveTurns(), 9_600);

    const result = await beforeTurn({
      chatId: "chat-1",
      path,
      summaries: [],
      contextWindow: 10_000,
      model: {} as never,
      modelId: "m1",
    });

    const row = fake.tables.chat_summary[0];
    expect(row).toMatchObject({ anchorId: "a1", chatId: "chat-1" });
    expect(result.summaryId).toBe(row.id);
    expect(result.backstopEngaged).toBe(true);
    // The fresh summary rides the first kept message.
    expect(result.messages[0].id).toBe("u2");
  });

  it("applies only, never takes, without a chatId (a Trigger run)", async () => {
    const fake = seedSummaryTable();
    const path = withReading(fiveTurns(), 9_600);

    const result = await beforeTurn({
      path,
      summaries: [],
      contextWindow: 10_000,
      model: {} as never,
      modelId: "m1",
    });

    expect(result.backstopEngaged).toBe(false);
    expect(result.summaryId).toBeUndefined();
    expect(result.messages.map((message) => message.id)).toEqual(
      fiveTurns().map((message) => message.id),
    );
    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(fake.tables.chat_summary).toHaveLength(0);
  });

  it("does not take when a usable summary already covers the wall", async () => {
    seedSummaryTable();
    const summary = summaryRow({
      anchorId: "a2",
      coveredIds: ["u1", "a1", "u2", "a2"],
    });
    const path = withReading(fiveTurns(), 9_600);

    const result = await beforeTurn({
      chatId: "chat-1",
      path,
      summaries: [summary],
      contextWindow: 10_000,
      model: {} as never,
      modelId: "m1",
    });

    expect(result.summaryId).toBe(summary.id);
    expect(result.backstopEngaged).toBe(false);
    expect(mockGenerateText).not.toHaveBeenCalled();
  });
});

describe("afterTurn", () => {
  beforeEach(stubPassIO);

  const direct = {
    orgId: "org-1",
    workspaceId: "ws-1",
    source: { providerId: "p1", modelId: "m1" },
  } as const;

  it("takes exactly one summary when the final occupancy crosses 0.8", async () => {
    const fake = seedSummaryTable();

    afterTurn({
      chatId: "chat-1",
      ...direct,
      path: withReading(fiveTurns(), 8_100),
      contextWindow: 10_000,
    });

    await vi.waitFor(() => expect(fake.tables.chat_summary).toHaveLength(1));
    expect(fake.tables.chat_summary[0]).toMatchObject({
      chatId: "chat-1",
      // The last 4 turns stay verbatim when the reading was taken bare.
      anchorId: "a1",
      coveredIds: ["u1", "a1"],
      text: "The summary.",
    });
  });

  it("takes nothing when the occupancy is below the trigger", () => {
    const fake = seedSummaryTable();

    afterTurn({
      chatId: "chat-1",
      ...direct,
      path: withReading(fiveTurns(), 7_000),
      contextWindow: 10_000,
    });

    expect(fake.tables.chat_summary).toHaveLength(0);
  });

  it("takes nothing for a model with no declared Context window", () => {
    const fake = seedSummaryTable();

    afterTurn({
      chatId: "chat-1",
      ...direct,
      path: withReading(fiveTurns(), 99_000),
    });

    expect(fake.tables.chat_summary).toHaveLength(0);
  });

  it("keeps one turn when the triggering reading was taken with a summary", async () => {
    const fake = seedSummaryTable();

    afterTurn({
      chatId: "chat-1",
      ...direct,
      path: withReading(fiveTurns(), 8_100, "sum-old"),
      contextWindow: 10_000,
    });

    await vi.waitFor(() => expect(fake.tables.chat_summary).toHaveLength(1));
    expect(fake.tables.chat_summary[0]).toMatchObject({ anchorId: "a4" });
  });

  // Issue #1717 (R1): a turn the Provider rejected as too long takes its
  // summary straight away, whatever the reading — so a regenerate, whose
  // path no longer holds the overflowed reply, still finds one waiting.
  it("takes a summary after a turn that overflowed, with no window or reading", async () => {
    const fake = seedSummaryTable();

    afterTurn({
      chatId: "chat-1",
      ...direct,
      path: overflowing(fiveTurns()),
    });

    await vi.waitFor(() => expect(fake.tables.chat_summary).toHaveLength(1));
    expect(fake.tables.chat_summary[0]).toMatchObject({ anchorId: "a1" });
  });

  it("shrinks from the summary the overflowed reply ran with", async () => {
    const fake = seedSummaryTable();

    afterTurn({
      chatId: "chat-1",
      ...direct,
      path: overflowing(fiveTurns(), "sum-old"),
    });

    await vi.waitFor(() => expect(fake.tables.chat_summary).toHaveLength(1));
    // Keeping one turn puts the anchor at a4.
    expect(fake.tables.chat_summary[0]).toMatchObject({ anchorId: "a4" });
  });

  it("never throws when the pass fails: it logs and writes nothing", async () => {
    const fake = seedSummaryTable();
    mockResolveGenerationPlan.mockRejectedValueOnce(new Error("agent gone"));

    expect(() =>
      afterTurn({
        chatId: "chat-1",
        ...direct,
        path: withReading(fiveTurns(), 8_100),
        contextWindow: 10_000,
      }),
    ).not.toThrow();

    await vi.waitFor(() =>
      expect(mockResolveGenerationPlan).toHaveBeenCalled(),
    );
    expect(fake.tables.chat_summary).toHaveLength(0);
  });

  it("never throws when the model call fails: it logs and writes nothing", async () => {
    const fake = seedSummaryTable();
    mockGenerateText.mockRejectedValueOnce(new Error("provider exploded"));

    expect(() =>
      afterTurn({
        chatId: "chat-1",
        ...direct,
        path: withReading(fiveTurns(), 8_100),
        contextWindow: 10_000,
      }),
    ).not.toThrow();

    await vi.waitFor(() => expect(mockGenerateText).toHaveBeenCalled());
    expect(fake.tables.chat_summary).toHaveLength(0);
  });
});
