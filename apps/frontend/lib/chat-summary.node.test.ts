import { describe, expect, it } from "vitest";
import {
  appliedTranscriptSummary,
  isSummaryUsable,
  latestReadingSummaryId,
  occupancyIsStaleAfterSummary,
  summarisingStatusOf,
} from "./chat-summary";
import type { PlatypusUIMessage } from "@platypus/schemas";
import type { ChatTranscriptSummary } from "./chat-summary";

/**
 * The send-time read's frontend half (ADR-0041, issue #1716): which summary
 * gets a divider, and when the composer meter must read "—".
 */

function user(id: string): PlatypusUIMessage {
  return { id, role: "user", parts: [{ type: "text", text: id }] };
}

function assistant(
  id: string,
  metadata?: PlatypusUIMessage["metadata"],
): PlatypusUIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text: id }],
    ...(metadata ? { metadata } : {}),
  };
}

function path(): PlatypusUIMessage[] {
  return [
    user("u1"),
    assistant("a1"),
    user("u2"),
    assistant("a2"),
    user("u3"),
    assistant("a3"),
  ];
}

function summary(
  over: Partial<ChatTranscriptSummary> &
    Pick<ChatTranscriptSummary, "anchorId" | "coveredIds">,
): ChatTranscriptSummary {
  return {
    id: `${over.anchorId}-sum`,
    chatId: "chat-1",
    text: "The summary.",
    stats: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("isSummaryUsable", () => {
  it("is usable when its covered ids are exactly the live path to the anchor", () => {
    expect(
      isSummaryUsable(
        summary({ anchorId: "a1", coveredIds: ["u1", "a1"] }),
        path(),
      ),
    ).toBe(true);
  });

  it("is unusable once a Delete inside the range changed the live path", () => {
    const afterDelete = path().filter((m) => m.id !== "u1");
    expect(
      isSummaryUsable(
        summary({ anchorId: "a1", coveredIds: ["u1", "a1"] }),
        afterDelete,
      ),
    ).toBe(false);
  });

  it("is unusable when the anchor no longer ends a turn", () => {
    // u2 deleted: a1 is followed by a2, so the summary has no first kept user.
    const afterDelete = path().filter((m) => m.id !== "u2");
    expect(
      isSummaryUsable(
        summary({ anchorId: "a1", coveredIds: ["u1", "a1"] }),
        afterDelete,
      ),
    ).toBe(false);
  });
});

describe("appliedTranscriptSummary", () => {
  it("returns the deepest usable summary and its anchor index", () => {
    const deep = summary({
      id: "deep",
      anchorId: "a2",
      coveredIds: ["u1", "a1", "u2", "a2"],
    });
    const shallow = summary({ anchorId: "a1", coveredIds: ["u1", "a1"] });
    const applied = appliedTranscriptSummary(path(), [deep, shallow]);
    expect(applied?.summary.id).toBe("deep");
    expect(applied?.anchorIndex).toBe(3);
  });

  it("skips a summary a Delete made unusable", () => {
    const afterDelete = path().filter((m) => m.id !== "u1");
    const deep = summary({
      id: "deep",
      anchorId: "a2",
      coveredIds: ["u1", "a1", "u2", "a2"],
    });
    expect(appliedTranscriptSummary(afterDelete, [deep])).toBeUndefined();
  });

  it("applies a /compact summary anchored at the leaf, which the next message carries", () => {
    const compacted = summary({
      anchorId: "a3",
      coveredIds: ["u1", "a1", "u2", "a2", "u3", "a3"],
    });
    expect(appliedTranscriptSummary(path(), [compacted])?.anchorIndex).toBe(5);
  });

  it("returns nothing for a Chat with no summaries", () => {
    expect(appliedTranscriptSummary(path(), undefined)).toBeUndefined();
    expect(appliedTranscriptSummary(path(), [])).toBeUndefined();
  });
});

describe("latestReadingSummaryId", () => {
  it("reads the summary id beside the newest occupancy reading", () => {
    const messages = path();
    messages[3] = assistant("a2", {
      contextOccupancy: { inputTokens: 10, outputTokens: 2 },
      summaryId: "sum-old",
    });
    messages[5] = assistant("a3", {
      contextOccupancy: { inputTokens: 20, outputTokens: 3 },
    });
    expect(latestReadingSummaryId(messages)).toBeUndefined();
  });

  it("returns undefined when no reading exists", () => {
    expect(latestReadingSummaryId(path())).toBeUndefined();
  });
});

describe("occupancyIsStaleAfterSummary", () => {
  it("is stale once a summary the last reading predates is in place", () => {
    const messages = path();
    messages[5] = assistant("a3", {
      contextOccupancy: { inputTokens: 9_000, outputTokens: 100 },
    });
    const applied = summary({
      anchorId: "a2",
      coveredIds: ["u1", "a1", "u2", "a2"],
    });
    expect(occupancyIsStaleAfterSummary(messages, [applied])).toBe(true);
  });

  it("is current when the last reading was taken through the same summary", () => {
    const messages = path();
    messages[5] = assistant("a3", {
      contextOccupancy: { inputTokens: 2_000, outputTokens: 100 },
      summaryId: "a2-sum",
    });
    const applied = summary({
      anchorId: "a2",
      coveredIds: ["u1", "a1", "u2", "a2"],
    });
    expect(occupancyIsStaleAfterSummary(messages, [applied])).toBe(false);
  });

  it("is not stale when no summary applies to the current path", () => {
    const messages = path();
    messages[5] = assistant("a3", {
      contextOccupancy: { inputTokens: 9_000, outputTokens: 100 },
    });
    expect(occupancyIsStaleAfterSummary(messages, [])).toBe(false);
  });
});

describe("summarisingStatusOf", () => {
  const withStatus = (text: string): PlatypusUIMessage[] => [
    user("u1"),
    {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "data-transcript-summary-status", data: { text } },
        { type: "text", text: "reply" },
      ],
    },
  ];

  it("reads the status off the turn's streamed message while it is in flight", () => {
    expect(summarisingStatusOf(withStatus("Summarising…"), true)).toBe(
      "Summarising…",
    );
  });

  it("is absent once the turn is over", () => {
    expect(
      summarisingStatusOf(withStatus("Summarising…"), false),
    ).toBeUndefined();
  });

  it("is absent for a turn that streamed no status", () => {
    expect(summarisingStatusOf(path(), true)).toBeUndefined();
  });
});
