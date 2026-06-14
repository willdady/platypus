import { describe, it, expect, vi } from "vitest";

vi.mock("../index.ts", () => ({ db: {} })); // drizzle store unused in these tests
vi.mock("../logger.ts", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  commitWatermark,
  compactUIMessages,
  compactModelMessages,
  editToolResults,
  elidedToolPlaceholder,
  pickKeepBoundary,
  softTrim,
  type CompactionStore,
  type CompactionState,
  type WatermarkPatch,
} from "./compaction.ts";
import { logger } from "../logger.ts";
import type { ModelMessage } from "ai";
import type { PlatypusUIMessage } from "../types.ts";

/**
 * In-memory store. Since JS is single-threaded, the version check in `casWrite`
 * is atomic per call — exactly the guarantee Postgres gives via the `version`
 * predicate. `readState` returns a snapshot copy, so a version bump that happens
 * after a read (a racing winner) makes that reader's snapshot stale → CAS fails.
 */
class FakeStore implements CompactionStore {
  state: CompactionState;
  casCalls = 0;

  constructor(init: Partial<CompactionState> = {}) {
    this.state = {
      version: 0,
      summaryWatermark: null,
      contextSummary: null,
      compactionDirty: false,
      ...init,
    };
  }

  async readState() {
    return { ...this.state };
  }

  async casWrite(
    _chatId: string,
    expectVersion: number,
    patch: WatermarkPatch,
  ) {
    this.casCalls++;
    if (this.state.version !== expectVersion) return false;
    if ("watermark" in patch)
      this.state.summaryWatermark = patch.watermark ?? null;
    if ("summary" in patch) this.state.contextSummary = patch.summary ?? null;
    if ("dirty" in patch) this.state.compactionDirty = patch.dirty ?? false;
    this.state.version = expectVersion + 1;
    return true;
  }
}

describe("casWrite — version-gated CAS (P3/R1)", () => {
  it("applies and bumps version when the expected version matches", async () => {
    const store = new FakeStore({ version: 3 });
    const won = await store.casWrite("c", 3, { summary: "s", watermark: "m1" });
    expect(won).toBe(true);
    expect(store.state.version).toBe(4);
    expect(store.state.contextSummary).toBe("s");
    expect(store.state.summaryWatermark).toBe("m1");
  });

  it("two writers on the same version: one wins, the other loses", async () => {
    const store = new FakeStore({ version: 0 });
    const first = await store.casWrite("c", 0, { summary: "A" });
    const second = await store.casWrite("c", 0, { summary: "B" });
    expect(first).toBe(true);
    expect(second).toBe(false); // version is now 1, expected 0
    expect(store.state.contextSummary).toBe("A");
  });

  it("an explicit null clears a field; an absent key leaves it untouched", async () => {
    const store = new FakeStore({
      version: 1,
      contextSummary: "old",
      summaryWatermark: "m5",
    });
    await store.casWrite("c", 1, { summary: null }); // reset summary only
    expect(store.state.contextSummary).toBeNull();
    expect(store.state.summaryWatermark).toBe("m5"); // untouched
  });
});

describe("commitWatermark — loser logic (drift T10/R1)", () => {
  it("applies a write on an uncontended commit", async () => {
    const store = new FakeStore({ version: 2 });
    const res = await commitWatermark(store, "c", () => ({
      kind: "write",
      patch: { summary: "sum", watermark: "m9" },
    }));
    expect(res).toEqual({ status: "applied", version: 3 });
    expect(store.state.summaryWatermark).toBe("m9");
  });

  it("skips immediately when the decision is a no-op", async () => {
    const store = new FakeStore({ version: 0 });
    const res = await commitWatermark(store, "c", () => ({
      kind: "skip",
      reason: "no-op",
    }));
    expect(res).toEqual({ status: "skipped", reason: "no-op" });
    expect(store.casCalls).toBe(0);
  });

  it("re-reads after a CAS conflict and succeeds on the retry", async () => {
    const store = new FakeStore({ version: 0 });
    let firstDecision = true;
    const res = await commitWatermark(store, "c", (state) => {
      if (firstDecision) {
        firstDecision = false;
        // Simulate a racing winner committing between our read and write.
        store.state.version = 1;
        store.state.summaryWatermark = "winner";
      }
      // Decide by the (re-read) version, not the watermark value.
      return { kind: "write", patch: { summary: `at-v${state.version}` } };
    });
    expect(res.status).toBe("applied");
    // First attempt CAS expected v0 but row is v1 → lost; retry expects v1 → wins.
    expect(store.state.version).toBe(2);
    expect(store.state.contextSummary).toBe("at-v1");
  });

  it("decides 'covered' on the retry and skips (winner already did the work)", async () => {
    const store = new FakeStore({ version: 0, summaryWatermark: "m1" });
    let first = true;
    const res = await commitWatermark(store, "c", (state) => {
      if (first) {
        first = false;
        store.state.version = 1;
        store.state.summaryWatermark = "m20"; // winner advanced past our prefix
        return { kind: "write", patch: { summary: "mine", watermark: "m10" } };
      }
      // On re-read we see the winner covered us → skip (decide by version).
      expect(state.version).toBe(1);
      return { kind: "skip", reason: "covered" };
    });
    expect(res).toEqual({ status: "skipped", reason: "covered" });
    expect(store.state.summaryWatermark).toBe("m20"); // winner's value preserved
  });

  it("gives up as 'contended' after two conflicts — no livelock", async () => {
    const store = new FakeStore({ version: 0 });
    let decideCalls = 0;
    const res = await commitWatermark(store, "c", (state) => {
      decideCalls++;
      // Every decision races a winner → both CAS attempts fail.
      store.state.version = state.version + 1;
      return { kind: "write", patch: { summary: "x" } };
    });
    expect(res).toEqual({ status: "skipped", reason: "contended" });
    expect(decideCalls).toBe(2); // exactly MAX_ATTEMPTS, then stop
  });
});

// --- Slice 2b: compaction primitives ------------------------------------

function uiText(
  id: string,
  role: "user" | "assistant",
  text: string,
): PlatypusUIMessage {
  return { id, role, parts: [{ type: "text", text }] } as PlatypusUIMessage;
}

function uiTool(id: string, output: unknown): PlatypusUIMessage {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: "tool-doThing",
        toolCallId: `${id}-call`,
        state: "output-available",
        input: {},
        output,
      },
    ],
  } as unknown as PlatypusUIMessage;
}

const noopSummarize = async () => "SUMMARY";

describe("softTrim", () => {
  it("keeps short text untouched", () => {
    expect(softTrim("short", 500)).toBe("short");
  });
  it("trims long text to head+tail with a marker", () => {
    const out = softTrim("a".repeat(2000), 100);
    expect(out.startsWith("a".repeat(100))).toBe(true);
    expect(out).toContain("elided 1800 chars");
    expect(out.length).toBeLessThan(2000);
  });
});

describe("pickKeepBoundary", () => {
  it("UIMessage: any split is safe", () => {
    expect(pickKeepBoundary(5, 2, () => true)).toBe(3);
  });
  it("ModelMessage: walks back so recent does not start on an orphan tool result", () => {
    const roles = ["user", "assistant", "tool", "user"];
    const safe = (i: number) => i >= roles.length || roles[i] !== "tool";
    // start at 4-2=2 (role "tool", unsafe) → walk back to 1 (assistant, safe)
    expect(pickKeepBoundary(4, 2, safe)).toBe(1);
  });
});

describe("compactUIMessages (Tier 1)", () => {
  const baseOpts = {
    keepRecentMessages: 2,
    minPrunableChars: 2000,
    summarize: noopSummarize,
  };

  it("is a no-op when already within target (hysteresis precondition)", async () => {
    const msgs = [uiText("a", "user", "hi"), uiText("b", "assistant", "yo")];
    const res = await compactUIMessages(msgs, {
      ...baseOpts,
      targetTokens: 1000,
    });
    expect(res.usedModelCall).toBe(false);
    expect(res.messagesDropped).toBe(0);
    expect(res.keptMessages).toBe(msgs);
  });

  it("Stage 1 prune reaches target WITHOUT a model call", async () => {
    const summarize = vi.fn(noopSummarize);
    const msgs = [
      uiTool("big", "X".repeat(4000)), // ~1000 tokens, prunes to ~250
      uiText("r1", "user", "hello"),
      uiText("r2", "assistant", "world"),
    ];
    const res = await compactUIMessages(msgs, {
      ...baseOpts,
      summarize,
      targetTokens: 300,
    });
    expect(res.usedModelCall).toBe(false);
    expect(summarize).not.toHaveBeenCalled();
    expect(res.watermarkId).toBeNull();
    expect(res.keptMessages).toHaveLength(3); // pruned prefix stays visible
    expect(res.estimatedTokens).toBeLessThanOrEqual(300);
  });

  it("Stage 2 summarizes when pruning is insufficient (text-heavy prefix)", async () => {
    const summarize = vi.fn(noopSummarize);
    const msgs = [
      uiText("p1", "user", "P".repeat(4000)),
      uiText("p2", "assistant", "Q".repeat(4000)),
      uiText("r1", "user", "hello"),
      uiText("r2", "assistant", "world"),
    ];
    const res = await compactUIMessages(msgs, {
      ...baseOpts,
      summarize,
      targetTokens: 300,
    });
    expect(res.usedModelCall).toBe(true);
    expect(summarize).toHaveBeenCalledOnce();
    expect(res.summaryText).toBe("SUMMARY");
    expect(res.watermarkId).toBe("p2"); // last folded message
    expect(res.keptMessages).toHaveLength(2); // only recent kept
    expect(res.estimatedTokens).toBeLessThanOrEqual(300);
  });

  it("does NOT re-fire next turn: feeding the result back is a no-op (C2)", async () => {
    const msgs = [
      uiText("p1", "user", "P".repeat(4000)),
      uiText("p2", "assistant", "Q".repeat(4000)),
      uiText("r1", "user", "hello"),
      uiText("r2", "assistant", "world"),
    ];
    const target = 300;
    const first = await compactUIMessages(msgs, {
      ...baseOpts,
      targetTokens: target,
    });
    expect(first.usedModelCall).toBe(true);

    const second = await compactUIMessages(first.keptMessages, {
      ...baseOpts,
      targetTokens: target,
      priorSummary: first.summaryText,
    });
    expect(second.usedModelCall).toBe(false); // already within target
    expect(second.messagesDropped).toBe(0);
  });

  it("map-reduces an oversized prefix (drift M1)", async () => {
    const summarize = vi.fn(noopSummarize);
    const msgs = [
      uiText("p1", "user", "Z".repeat(4000)), // ~1000 tokens of transcript
      uiText("r1", "user", "hello"),
      uiText("r2", "assistant", "world"),
    ];
    await compactUIMessages(msgs, {
      ...baseOpts,
      summarize,
      targetTokens: 50,
      summarizerWindow: 100, // 400-char chunks → several chunk calls + 1 reduce
    });
    expect(summarize.mock.calls.length).toBeGreaterThan(1);
  });

  it("Stage 2 prunes large tool results in kept (recent) messages", async () => {
    const msgs = [
      uiText("p1", "user", "P".repeat(4000)),
      uiText("p2", "assistant", "Q".repeat(4000)),
      uiTool("r1", "X".repeat(12000)), // big tool result in recent
      uiText("r2", "user", "done"),
    ];
    const res = await compactUIMessages(msgs, {
      ...baseOpts,
      summarize: noopSummarize,
      targetTokens: 300,
      minRecentPrunableChars: 5000, // 12000-char output exceeds threshold
    });
    expect(res.usedModelCall).toBe(true);
    expect(res.keptMessages).toHaveLength(2); // r1 + r2
    // Tool result in r1 should be trimmed (soft-trim produces head+tail, not full string)
    const toolPart = res.keptMessages[0].parts?.find((p) =>
      (p as { type: string }).type.startsWith("tool-"),
    ) as { output?: string } | undefined;
    expect(typeof toolPart?.output).toBe("string");
    expect((toolPart?.output as string).length).toBeLessThan(12000);
  });

  it("Stage 2 does not prune recent tool results below minRecentPrunableChars", async () => {
    const msgs = [
      uiText("p1", "user", "P".repeat(4000)),
      uiText("p2", "assistant", "Q".repeat(4000)),
      uiTool("r1", "X".repeat(3000)), // below threshold of 20000
      uiText("r2", "user", "done"),
    ];
    const res = await compactUIMessages(msgs, {
      ...baseOpts,
      summarize: noopSummarize,
      targetTokens: 300,
      minRecentPrunableChars: 20000, // threshold above 3000 → no pruning
    });
    expect(res.usedModelCall).toBe(true);
    const toolPart = res.keptMessages[0].parts?.find((p) =>
      (p as { type: string }).type.startsWith("tool-"),
    ) as { output?: string } | undefined;
    // Output unchanged — 3000 chars below threshold
    expect(toolPart?.output).toBe("X".repeat(3000));
  });

  it("prunes large recent tool results when the prefix is empty (no summary)", async () => {
    // Whole history fits within keepRecentMessages (2) but a huge tool result
    // pushes it over target. boundary=0 → empty prefix → no model call, but the
    // outlier in recent must still be trimmed (Finding 1 gap).
    const msgs = [
      uiTool("r1", "X".repeat(12000)), // big tool result, no prefix to summarize
      uiText("r2", "user", "done"),
    ];
    const res = await compactUIMessages(msgs, {
      ...baseOpts,
      summarize: noopSummarize,
      targetTokens: 300,
      minRecentPrunableChars: 5000,
    });
    expect(res.usedModelCall).toBe(false); // empty prefix → no summarize
    const toolPart = res.keptMessages[0].parts?.find((p) =>
      (p as { type: string }).type.startsWith("tool-"),
    ) as { output?: string } | undefined;
    expect(typeof toolPart?.output).toBe("string");
    expect((toolPart?.output as string).length).toBeLessThan(12000);
  });

  it("option D: keeps recent VERBATIM in the empty-prefix path when within inputBudget", async () => {
    // Whole history fits within keepRecentMessages (2) → empty prefix, no model
    // call. Over the soft target but under the wall → outlier must stay untouched.
    const msgs = [
      uiTool("r1", "X".repeat(12000)),
      uiText("r2", "user", "done"),
    ];
    const res = await compactUIMessages(msgs, {
      ...baseOpts,
      summarize: noopSummarize,
      targetTokens: 300,
      minRecentPrunableChars: 5000,
      inputBudget: 100000, // wall far above → no recent trim
    });
    expect(res.usedModelCall).toBe(false);
    const toolPart = res.keptMessages[0].parts?.find((p) =>
      (p as { type: string }).type.startsWith("tool-"),
    ) as { output?: string } | undefined;
    expect(toolPart?.output).toBe("X".repeat(12000)); // untouched
  });

  it("warns (no wall) when Stage 2 result still exceeds 2× targetTokens after pruning", async () => {
    const warn = vi.spyOn(logger, "warn").mockReturnValue(undefined);
    const msgs = [
      uiText("p1", "user", "P".repeat(4000)),
      uiText("p2", "assistant", "Q".repeat(4000)),
      // recent messages are huge text (not tool), cannot be pruned
      uiText("r1", "user", "R".repeat(8000)),
      uiText("r2", "assistant", "S".repeat(8000)),
    ];
    await compactUIMessages(msgs, {
      ...baseOpts,
      summarize: noopSummarize,
      targetTokens: 50, // recent alone is ~4000 tokens → well over 2×50
      // no inputBudget → warn falls back to the target*2 heuristic
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ targetTokens: 50 }),
      expect.stringContaining("recent messages exceed the window"),
    );
    warn.mockRestore();
  });

  it("option D: does NOT warn on a soft-target miss when recent is under the wall", async () => {
    const warn = vi.spyOn(logger, "warn").mockReturnValue(undefined);
    const msgs = [
      uiText("p1", "user", "P".repeat(4000)),
      uiText("p2", "assistant", "Q".repeat(4000)),
      uiText("r1", "user", "R".repeat(8000)),
      uiText("r2", "assistant", "S".repeat(8000)),
    ];
    await compactUIMessages(msgs, {
      ...baseOpts,
      summarize: noopSummarize,
      targetTokens: 50, // way over target...
      inputBudget: 100000, // ...but well under the hard wall → no warn
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("option D: keeps recent tool results VERBATIM when within inputBudget", async () => {
    // Over the soft target (300) so Stage 2 fires, but the kept view (summary +
    // recent) stays under the hard wall → recent must NOT be trimmed.
    const msgs = [
      uiText("p1", "user", "P".repeat(4000)),
      uiText("p2", "assistant", "Q".repeat(4000)),
      uiTool("r1", "X".repeat(12000)), // ~3000 tokens in recent
      uiText("r2", "user", "done"),
    ];
    const res = await compactUIMessages(msgs, {
      ...baseOpts,
      summarize: noopSummarize,
      targetTokens: 300,
      minRecentPrunableChars: 5000,
      inputBudget: 100000, // wall far above the kept view → no recent trim
    });
    expect(res.usedModelCall).toBe(true);
    const toolPart = res.keptMessages[0].parts?.find((p) =>
      (p as { type: string }).type.startsWith("tool-"),
    ) as { output?: string } | undefined;
    expect(toolPart?.output).toBe("X".repeat(12000)); // untouched
  });

  it("option D: trims recent (except newest) when the kept view breaches inputBudget", async () => {
    // Two big tool results in recent; the kept view breaches the wall → trim the
    // older one, exempt the single newest message even though it is bulky.
    const msgs = [
      uiText("p1", "user", "P".repeat(4000)),
      uiText("p2", "assistant", "Q".repeat(4000)),
      uiTool("r1", "X".repeat(12000)), // older recent → trimmed
      uiTool("r2", "Y".repeat(12000)), // newest → exempt
    ];
    const res = await compactUIMessages(msgs, {
      ...baseOpts,
      summarize: noopSummarize,
      targetTokens: 300,
      minRecentPrunableChars: 5000,
      inputBudget: 100, // wall well below the kept view → trim
    });
    expect(res.usedModelCall).toBe(true);
    const out = (i: number) =>
      (
        res.keptMessages[i].parts?.find((p) =>
          (p as { type: string }).type.startsWith("tool-"),
        ) as { output?: string } | undefined
      )?.output;
    expect((out(0) as string).length).toBeLessThan(12000); // r1 trimmed
    expect(out(1)).toBe("Y".repeat(12000)); // r2 (newest) exempt
  });
});

describe("compactModelMessages (Tier 2 / recovery)", () => {
  const baseOpts = {
    keepRecentMessages: 2,
    minPrunableChars: 2000,
    summarize: noopSummarize,
  };

  it("is a no-op when within target", async () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ];
    const res = await compactModelMessages(msgs, {
      ...baseOpts,
      targetTokens: 1000,
    });
    expect(res.usedModelCall).toBe(false);
    expect(res.messages).toBe(msgs);
  });

  it("summarizes and prepends one synthetic message, preserving tool pairing", async () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: "P".repeat(4000) },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "t1", toolName: "f", input: {} },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "t1",
            toolName: "f",
            output: { type: "json", value: { ok: true } },
          },
        ],
      },
      { role: "user", content: "recent" },
    ];
    const res = await compactModelMessages(msgs, {
      ...baseOpts,
      targetTokens: 50,
    });
    expect(res.usedModelCall).toBe(true);
    // First message is the synthetic summary (user-framed).
    expect(res.messages[0].role).toBe("user");
    expect(JSON.stringify(res.messages[0].content)).toContain(
      "Summary of earlier conversation",
    );
    // The assistant tool-call and its tool result stay adjacent (not split).
    const roles = res.messages.map((m) => m.role);
    const toolIdx = roles.indexOf("tool");
    expect(roles[toolIdx - 1]).toBe("assistant");
  });

  it("force bypasses BOTH no-op gates so recovery never retries byte-identically (RV3)", async () => {
    // Estimator says we are within target AND nothing is prunable (small,
    // non-bulky messages). Without force both the whole-message gate and the
    // post-prune gate would no-op → recovery would retry the exact same prompt
    // and fail again. force must push through to a real summarize.
    const msgs: ModelMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "recent-1" },
      { role: "assistant", content: "recent-2" },
    ];
    const res = await compactModelMessages(msgs, {
      ...baseOpts,
      targetTokens: 100000, // estimator is well under target
      force: true,
    });
    expect(res.usedModelCall).toBe(true);
    expect(res.messagesDropped).toBeGreaterThan(0);
    expect(res.messages).not.toBe(msgs);
  });

  it("force with an empty prefix is a no-op, not a prompt-growing summary (RV4 model-side)", async () => {
    // recent alone exceeds keepRecentMessages → prefix is empty. Summarizing
    // nothing would ADD a synthetic message and grow the prompt, never
    // converging. Surface the overflow instead.
    const msgs: ModelMessage[] = [
      { role: "user", content: "only-1" },
      { role: "assistant", content: "only-2" },
    ];
    const res = await compactModelMessages(msgs, {
      ...baseOpts,
      keepRecentMessages: 2,
      targetTokens: 1,
      force: true,
    });
    expect(res.usedModelCall).toBe(false);
    expect(res.messages.length).toBe(msgs.length);
  });
});

// --- Slice 2c: Tier 1 orchestration -------------------------------------

import {
  applyTier1Compaction,
  buildCompactionTraceMessage,
  computeBudget,
  invalidateCompaction,
  affectedBelowWatermark,
  summaryUIMessage,
  DEFAULT_COMPACTION_CONFIG,
  type Budget,
  type CompactionConfig,
} from "./compaction.ts";

describe("buildCompactionTraceMessage (§J/11c)", () => {
  it("builds an assistant message with a completed compact_context tool part", () => {
    const msg = buildCompactionTraceMessage(
      { messagesDropped: 7, summaryExcerpt: "did things" },
      "msg-abc",
    );
    expect(msg.id).toBe("msg-abc");
    expect(msg.role).toBe("assistant");
    expect(msg.parts).toHaveLength(1);
    const part = msg.parts[0] as {
      type: string;
      state: string;
      toolCallId: string;
      output: unknown;
    };
    expect(part.type).toBe("tool-compact_context");
    expect(part.state).toBe("output-available");
    expect(part.toolCallId).toBe("msg-abc-call");
    expect(part.output).toEqual({
      messagesDropped: 7,
      summaryExcerpt: "did things",
    });
  });

  it("omits summaryExcerpt from the output when absent", () => {
    const msg = buildCompactionTraceMessage({ messagesDropped: 1 }, "msg-x");
    const part = msg.parts[0] as { output: unknown };
    expect(part.output).toEqual({ messagesDropped: 1 });
  });
});

function storeFromState(state: Partial<CompactionState>): FakeStore {
  return new FakeStore(state);
}

const cfg = (over: Partial<CompactionConfig> = {}): CompactionConfig => ({
  ...DEFAULT_COMPACTION_CONFIG,
  keepRecentMessages: 2,
  ...over,
});

describe("computeBudget (drift C3 — subtract both reserves)", () => {
  it("subtracts output + safety reserve before applying ratios", () => {
    const b = computeBudget(
      10000,
      2000,
      cfg({ reserveRatio: 0.05, triggerRatio: 0.8, targetRatio: 0.5 }),
    );
    expect(b.inputBudget).toBe(7500); // 10000 - 2000 - 500
    expect(b.triggerTokens).toBe(6000);
    expect(b.targetTokens).toBe(3750);
  });
  it("uses a conservative output reserve when maxOutputTokens is unknown", () => {
    const b = computeBudget(10000, undefined, cfg({ reserveRatio: 0.05 }));
    expect(b.inputBudget).toBe(7000); // 10000 - min(4096, 2500) - 500
  });

  it("caps the output reserve at half the window so inputBudget can't collapse (A6)", () => {
    // A bogus registry entry where max_output >= the input-scoped window would
    // otherwise drive inputBudget toward 1 and thrash. The cap keeps it sane.
    const b = computeBudget(10000, 20000, cfg({ reserveRatio: 0.05 }));
    // reserve capped at 5000 (half), safety 500 → 10000 - 5000 - 500 = 4500.
    expect(b.inputBudget).toBe(4500);
  });
});

const bigText = (id: string, role: "user" | "assistant") =>
  uiText(id, role, "X".repeat(4000));

describe("applyTier1Compaction", () => {
  const baseBudget: Budget = {
    inputBudget: 100,
    triggerTokens: 50,
    targetTokens: 50,
  };

  it("under trigger: reconstructs the persisted view, no write", async () => {
    const store = storeFromState({
      version: 2,
      summaryWatermark: "m2",
      contextSummary: "PRIOR",
    });
    const messages = ["m1", "m2", "m3", "m4"].map((id) =>
      uiText(id, "user", "hi"),
    );
    const out = await applyTier1Compaction({
      chatId: "c",
      messages,
      state: {
        version: 2,
        summaryWatermark: "m2",
        contextSummary: "PRIOR",
        compactionDirty: false,
      },
      budget: {
        inputBudget: 100000,
        triggerTokens: 100000,
        targetTokens: 50000,
      },
      config: cfg(),
      imageProvider: "default",
      summarize: noopSummarize,
      store,
    });
    expect(out.compacted).toBe(false);
    expect(out.messages[0]).toEqual(summaryUIMessage("PRIOR")); // re-injected summary
    expect(out.messages.map((m) => m.id)).toEqual([
      "context-summary",
      "m3",
      "m4",
    ]); // dropped ≤ watermark
    expect(store.casCalls).toBe(0); // nothing persisted
  });

  it("over trigger: compacts, persists summary+watermark, clears dirty, fires event", async () => {
    const store = storeFromState({ version: 0 });
    const onEvent = vi.fn();
    const messages = [
      bigText("p1", "user"),
      bigText("p2", "assistant"),
      uiText("r1", "user", "a"),
      uiText("r2", "assistant", "b"),
    ];
    const out = await applyTier1Compaction({
      chatId: "c",
      messages,
      state: {
        version: 0,
        summaryWatermark: null,
        contextSummary: null,
        compactionDirty: false,
      },
      budget: baseBudget,
      config: cfg(),
      imageProvider: "default",
      summarize: noopSummarize,
      store,
      onEvent,
    });
    expect(out.compacted).toBe(true);
    expect(store.state.contextSummary).toBe("SUMMARY");
    expect(store.state.summaryWatermark).toBe("p2");
    expect(store.state.compactionDirty).toBe(false);
    expect(store.state.version).toBe(1);
    expect(out.messages[0].id).toBe("context-summary");
    expect(onEvent).toHaveBeenCalledOnce();
    // §K/11c: a summary ran → a trace is surfaced with the dropped count and a
    // summary excerpt.
    expect(out.compactionTrace).toEqual({
      messagesDropped: 2,
      summaryExcerpt: "SUMMARY",
    });
  });

  it("disabled + not dirty: no compaction even when over the trigger", async () => {
    const store = storeFromState({ version: 0 });
    const messages = [
      bigText("p1", "user"),
      bigText("p2", "assistant"),
      uiText("r1", "user", "a"),
    ];
    const out = await applyTier1Compaction({
      chatId: "c",
      messages,
      state: {
        version: 0,
        summaryWatermark: null,
        contextSummary: null,
        compactionDirty: false,
      },
      budget: baseBudget,
      config: cfg({ compactionEnabled: false }),
      imageProvider: "default",
      summarize: noopSummarize,
      store,
    });
    expect(out.compacted).toBe(false);
    expect(store.casCalls).toBe(0);
  });

  it("dirty forces compaction even when proactive is disabled (P4 recovery hand-off)", async () => {
    const store = storeFromState({ version: 0, compactionDirty: true });
    const messages = [
      bigText("p1", "user"),
      bigText("p2", "assistant"),
      uiText("r1", "user", "a"),
      uiText("r2", "assistant", "b"),
    ];
    const out = await applyTier1Compaction({
      chatId: "c",
      messages,
      state: {
        version: 0,
        summaryWatermark: null,
        contextSummary: null,
        compactionDirty: true,
      },
      budget: baseBudget,
      config: cfg({ compactionEnabled: false }),
      imageProvider: "default",
      summarize: noopSummarize,
      store,
    });
    expect(out.compacted).toBe(true);
    expect(store.state.compactionDirty).toBe(false);
  });

  it("dirty but already within target: just clears the flag (no summary)", async () => {
    const store = storeFromState({ version: 0, compactionDirty: true });
    const messages = [
      uiText("r1", "user", "a"),
      uiText("r2", "assistant", "b"),
    ];
    const out = await applyTier1Compaction({
      chatId: "c",
      messages,
      state: {
        version: 0,
        summaryWatermark: null,
        contextSummary: null,
        compactionDirty: true,
      },
      budget: {
        inputBudget: 100000,
        triggerTokens: 100000,
        targetTokens: 100000,
      },
      config: cfg(),
      imageProvider: "default",
      summarize: noopSummarize,
      store,
    });
    expect(out.compacted).toBe(false);
    expect(store.state.compactionDirty).toBe(false); // flag cleared
    expect(store.state.contextSummary).toBeNull(); // no summary written
    expect(store.state.version).toBe(1);
    // §K/11c: no model summary ran → no trace (would be an empty timeline entry).
    expect(out.compactionTrace).toBeUndefined();
  });

  it("under trigger: no trace surfaced", async () => {
    const store = storeFromState({ version: 0 });
    const messages = [uiText("r1", "user", "a")];
    const out = await applyTier1Compaction({
      chatId: "c",
      messages,
      state: {
        version: 0,
        summaryWatermark: null,
        contextSummary: null,
        compactionDirty: false,
      },
      budget: {
        inputBudget: 100000,
        triggerTokens: 100000,
        targetTokens: 50000,
      },
      config: cfg(),
      imageProvider: "default",
      summarize: noopSummarize,
      store,
    });
    expect(out.compacted).toBe(false);
    expect(out.compactionTrace).toBeUndefined();
  });
});

describe("invalidateCompaction (drift C4)", () => {
  const ordered = ["m1", "m2", "m3", "m4"];

  it("resets summary + watermark when a message at/below the watermark changes", async () => {
    const store = storeFromState({
      version: 5,
      summaryWatermark: "m2",
      contextSummary: "S",
    });
    const res = await invalidateCompaction(store, "c", ["m2"], ordered);
    expect(res.status).toBe("applied");
    expect(store.state.summaryWatermark).toBeNull();
    expect(store.state.contextSummary).toBeNull();
    expect(store.state.version).toBe(6); // bumped so a racing compaction loses (R1)
  });

  it("is a no-op when the edit is entirely above the watermark", async () => {
    const store = storeFromState({
      version: 5,
      summaryWatermark: "m2",
      contextSummary: "S",
    });
    const res = await invalidateCompaction(store, "c", ["m4"], ordered);
    expect(res).toEqual({ status: "skipped", reason: "no-op" });
    expect(store.state.contextSummary).toBe("S");
  });

  it("resets when an affected message was deleted (missing from ordering)", async () => {
    const store = storeFromState({
      version: 1,
      summaryWatermark: "m3",
      contextSummary: "S",
    });
    const res = await invalidateCompaction(store, "c", ["gone"], ordered);
    expect(res.status).toBe("applied");
    expect(store.state.summaryWatermark).toBeNull();
  });

  it("is a no-op when there is no summary/watermark to invalidate", async () => {
    const store = storeFromState({ version: 0 });
    const res = await invalidateCompaction(store, "c", ["m1"], ordered);
    expect(res).toEqual({ status: "skipped", reason: "no-op" });
  });
});

describe("affectedBelowWatermark (C4 divergence detection)", () => {
  const persisted = [
    uiText("m1", "user", "one"),
    uiText("m2", "assistant", "two"),
    uiText("m3", "user", "three"),
  ];

  it("returns [] when the prefix is unchanged", () => {
    const incoming = [
      uiText("m1", "user", "one"),
      uiText("m2", "assistant", "two"),
      uiText("m3", "user", "x"),
    ];
    expect(affectedBelowWatermark(persisted, incoming, "m2")).toEqual([]);
  });

  it("flags a content edit at/below the watermark", () => {
    const incoming = [
      uiText("m1", "user", "EDITED"),
      uiText("m2", "assistant", "two"),
      uiText("m3", "user", "three"),
    ];
    expect(affectedBelowWatermark(persisted, incoming, "m2")).toEqual(["m1"]);
  });

  it("flags a deleted message below the watermark", () => {
    const incoming = [
      uiText("m2", "assistant", "two"),
      uiText("m3", "user", "three"),
    ];
    expect(affectedBelowWatermark(persisted, incoming, "m2")).toEqual(["m1"]);
  });

  it("flags when the watermark message itself is gone from canonical history", () => {
    expect(affectedBelowWatermark(persisted, persisted, "ghost")).toEqual([
      "ghost",
    ]);
  });

  it("ignores edits strictly above the watermark", () => {
    const incoming = [
      uiText("m1", "user", "one"),
      uiText("m2", "assistant", "two"),
      uiText("m3", "user", "CHANGED"),
    ];
    expect(affectedBelowWatermark(persisted, incoming, "m2")).toEqual([]);
  });
});

// --- Chunk 3: C1/M2 trigger projection + recovery dirty-flag producer -----

import {
  projectTier1Tokens,
  setCompactionDirty,
  COLD_START_MARGIN,
} from "./compaction.ts";

describe("projectTier1Tokens (drift C1/M2)", () => {
  it("applies the cold-start margin when no provider baseline exists (M2)", () => {
    expect(
      projectTier1Tokens({ messageTokens: 100, priorSummaryTokens: 0 }),
    ).toBe(Math.ceil(100 * COLD_START_MARGIN));
  });

  it("counts the per-turn overhead toward the trigger (C1)", () => {
    expect(
      projectTier1Tokens({
        messageTokens: 100,
        priorSummaryTokens: 20,
        overheadTokens: 50,
      }),
    ).toBe(Math.ceil(170 * COLD_START_MARGIN));
  });

  it("uses the provider-reported count as a floor when available", () => {
    // The observed live gap: char/4 said ~986, the provider said 8888.
    expect(
      projectTier1Tokens({
        messageTokens: 986,
        priorSummaryTokens: 0,
        lastInputTokens: 8888,
      }),
    ).toBe(8888);
  });

  it("drops the margin when a provider baseline is present", () => {
    expect(
      projectTier1Tokens({
        messageTokens: 100,
        priorSummaryTokens: 0,
        lastInputTokens: 50,
      }),
    ).toBe(100);
  });

  it("treats a 0 provider count as no baseline and keeps the margin (A1)", () => {
    // Usage-less providers persist contextTokens=0; a bare `== null` check would
    // skip the margin AND no-op the max(), leaving the raw char/4 with no buffer.
    expect(
      projectTier1Tokens({
        messageTokens: 100,
        priorSummaryTokens: 0,
        lastInputTokens: 0,
      }),
    ).toBe(Math.ceil(100 * COLD_START_MARGIN));
  });
});

describe("applyTier1Compaction — overhead in the trigger (C1)", () => {
  it("fires on system/tool overhead even when messages alone are under trigger", async () => {
    const store = storeFromState({ version: 0 });
    // ~4 tokens of messages — far under the 50-token trigger on their own.
    const messages = [
      uiText("p1", "user", "aaaa"),
      uiText("p2", "assistant", "bbbb"),
      uiText("r1", "user", "cccc"),
      uiText("r2", "assistant", "dddd"),
    ];
    const out = await applyTier1Compaction({
      chatId: "c",
      messages,
      state: {
        version: 0,
        summaryWatermark: null,
        contextSummary: null,
        compactionDirty: false,
      },
      budget: { inputBudget: 100, triggerTokens: 50, targetTokens: 25 },
      config: cfg(),
      imageProvider: "default",
      summarize: noopSummarize,
      store,
      overheadTokens: 60, // tool schemas + system prompt dominate
    });
    expect(out.compacted).toBe(true);
    expect(store.state.summaryWatermark).toBe("p2");
  });

  it("does not fire when messages + overhead stay under the trigger", async () => {
    const store = storeFromState({ version: 0 });
    const messages = [
      uiText("r1", "user", "cccc"),
      uiText("r2", "assistant", "dddd"),
    ];
    const out = await applyTier1Compaction({
      chatId: "c",
      messages,
      state: {
        version: 0,
        summaryWatermark: null,
        contextSummary: null,
        compactionDirty: false,
      },
      budget: { inputBudget: 100, triggerTokens: 50, targetTokens: 25 },
      config: cfg(),
      imageProvider: "default",
      summarize: noopSummarize,
      store,
      overheadTokens: 10,
    });
    expect(out.compacted).toBe(false);
    expect(store.casCalls).toBe(0);
  });
});

describe("setCompactionDirty (§E recovery producer, drift T3)", () => {
  it("sets the flag through the CAS writer", async () => {
    const store = storeFromState({ version: 3 });
    const res = await setCompactionDirty(store, "c");
    expect(res).toEqual({ status: "applied", version: 4 });
    expect(store.state.compactionDirty).toBe(true);
  });

  it("is a no-op when already dirty (no version churn)", async () => {
    const store = storeFromState({ version: 3, compactionDirty: true });
    const res = await setCompactionDirty(store, "c");
    expect(res).toEqual({ status: "skipped", reason: "no-op" });
    expect(store.casCalls).toBe(0);
    expect(store.state.version).toBe(3);
  });

  it("never touches summary or watermark (recovery only flags)", async () => {
    const store = storeFromState({
      version: 1,
      contextSummary: "KEEP",
      summaryWatermark: "m7",
    });
    await setCompactionDirty(store, "c");
    expect(store.state.contextSummary).toBe("KEEP");
    expect(store.state.summaryWatermark).toBe("m7");
  });
});

// --- Chunk 14 Task 2: Stage 0 context editing ---------------------------

/** Tool message with a named tool and arbitrary output. */
const toolMsg = (
  id: string,
  name: string,
  output: unknown,
): PlatypusUIMessage =>
  ({
    id,
    role: "assistant",
    parts: [
      {
        type: `tool-${name}`,
        toolCallId: `${id}-call`,
        state: "output-available",
        input: { q: "x" },
        output,
      },
    ],
  }) as unknown as PlatypusUIMessage;

const bigOut = (n = 200) => "D".repeat(n);
const outputOf = (m: PlatypusUIMessage) =>
  (m.parts[0] as { output?: unknown }).output;

describe("editToolResults (Stage 0 — context editing)", () => {
  const opts = { keepRecentToolResults: 1, minEditableToolChars: 100 };

  it("elides OLD bulky results past the keep-window; keeps recent + all text", () => {
    const messages = [
      toolMsg("t1", "search", bigOut()),
      uiText("u1", "user", "carry on"),
      toolMsg("t2", "search", bigOut()),
      toolMsg("t3", "search", bigOut()),
    ];
    const res = editToolResults(messages, opts);
    // 3 results, keep last 1 (t3) → t1, t2 are candidates and both bulky.
    expect(res.resultsElided).toBe(2);
    expect(outputOf(res.messages[0])).toBe(
      elidedToolPlaceholder("search", 200),
    );
    expect(outputOf(res.messages[2])).toBe(
      elidedToolPlaceholder("search", 200),
    );
    expect(outputOf(res.messages[3])).toBe(bigOut()); // t3 within keep-window
    expect(res.messages[1]).toBe(messages[1]); // text untouched (same ref)
  });

  it("keeps results within keepRecentToolResults verbatim", () => {
    const messages = [
      toolMsg("t1", "f", bigOut()),
      toolMsg("t2", "f", bigOut()),
      toolMsg("t3", "f", bigOut()),
    ];
    const res = editToolResults(messages, {
      keepRecentToolResults: 2,
      minEditableToolChars: 100,
    });
    expect(res.resultsElided).toBe(1); // only t1
    expect(outputOf(res.messages[0])).toBe(elidedToolPlaceholder("f", 200));
    expect(outputOf(res.messages[1])).toBe(bigOut());
    expect(outputOf(res.messages[2])).toBe(bigOut());
  });

  it("exempts the newest message even with keepRecentToolResults=0", () => {
    const messages = [
      toolMsg("t1", "f", bigOut()),
      toolMsg("t2", "f", bigOut()),
    ];
    const res = editToolResults(messages, {
      keepRecentToolResults: 0,
      minEditableToolChars: 100,
    });
    expect(res.resultsElided).toBe(1); // t1 only; t2 is the newest message
    expect(outputOf(res.messages[0])).toBe(elidedToolPlaceholder("f", 200));
    expect(outputOf(res.messages[1])).toBe(bigOut());
  });

  it("size gate: leaves results at/under minEditableToolChars untouched", () => {
    const messages = [
      toolMsg("small", "f", bigOut(50)), // ≤ gate
      toolMsg("big", "f", bigOut(200)), // > gate
      uiText("u1", "user", "tail"), // newest, so both tools are candidates
    ];
    const res = editToolResults(messages, {
      keepRecentToolResults: 0,
      minEditableToolChars: 100,
    });
    expect(res.resultsElided).toBe(1);
    expect(outputOf(res.messages[0])).toBe(bigOut(50)); // small kept
    expect(outputOf(res.messages[1])).toBe(elidedToolPlaceholder("f", 200));
  });

  it("pairing: keeps the tool-call part, swaps only the output body", () => {
    const messages = [
      toolMsg("t1", "search", bigOut()),
      uiText("u1", "user", "x"),
    ];
    const res = editToolResults(messages, {
      keepRecentToolResults: 0,
      minEditableToolChars: 100,
    });
    const part = res.messages[0].parts[0] as Record<string, unknown>;
    expect(part.type).toBe("tool-search");
    expect(part.toolCallId).toBe("t1-call");
    expect(part.input).toEqual({ q: "x" });
    expect(part.state).toBe("output-available");
    expect(part.output).toBe(elidedToolPlaceholder("search", 200));
  });

  it("is deterministic/monotonic: feeding the edited view back elides nothing new", () => {
    const messages = [
      toolMsg("t1", "f", bigOut()),
      toolMsg("t2", "f", bigOut()),
      uiText("u1", "user", "tail"),
    ];
    const first = editToolResults(messages, opts);
    expect(first.resultsElided).toBeGreaterThan(0);
    const second = editToolResults(first.messages, opts);
    expect(second.resultsElided).toBe(0);
    expect(second.messages).toBe(first.messages); // stable ⇒ cache-friendly
  });

  it("grow-guard: never elides when the placeholder would be longer than the output", () => {
    // Tiny gate picks a result just over it, but shorter than the ~140-char
    // placeholder ⇒ eliding would inflate the prompt. Must skip (no negative
    // reclaim, no churn, no-op identity).
    const shortOut = "D".repeat(30); // > gate 10, < placeholder length
    const messages = [
      toolMsg("t1", "f", shortOut),
      uiText("u1", "user", "tail"),
    ];
    const res = editToolResults(messages, {
      keepRecentToolResults: 0,
      minEditableToolChars: 10,
    });
    expect(res.resultsElided).toBe(0);
    expect(res.charsReclaimed).toBe(0);
    expect(res.messages).toBe(messages);
  });

  it("no-op identity: returns the same array reference when nothing qualifies", () => {
    const messages = [
      toolMsg("t1", "f", bigOut(50)), // under gate
      uiText("u1", "user", "hi"),
    ];
    const res = editToolResults(messages, opts);
    expect(res.resultsElided).toBe(0);
    expect(res.charsReclaimed).toBe(0);
    expect(res.messages).toBe(messages);
  });
});

describe("applyTier1Compaction — Stage 0 avoids summarization (Task 2)", () => {
  const hugeTool = (id: string) => toolMsg(id, "dump", "Z".repeat(8000));
  // High minPrunableChars so Stage 1 prefix-pruning does NOT rescue the no-edit
  // case — it must reach Stage 2 (the model call) to make Stage 0's avoidance of
  // it the real discriminator.
  const editCfg = cfg({
    keepRecentToolResults: 1,
    minEditableToolChars: 100,
    keepRecentMessages: 2,
    minPrunableChars: 100000,
  });
  // Trigger sits between the post-edit size (~one big tool left) and the
  // pre-edit size (~two big tools).
  const budget: Budget = {
    inputBudget: 100000,
    triggerTokens: 3000,
    targetTokens: 1500,
  };
  const state: CompactionState = {
    version: 0,
    summaryWatermark: null,
    contextSummary: null,
    compactionDirty: false,
  };
  const messages = () => [
    hugeTool("bt1"),
    hugeTool("bt2"),
    uiText("r1", "user", "ok"),
    uiText("r2", "assistant", "done"),
  ];

  it("elides the old dump, drops under trigger, skips the model call", async () => {
    const summarize = vi.fn(async () => "SUMMARY");
    const out = await applyTier1Compaction({
      chatId: "c",
      messages: messages(),
      state,
      budget,
      config: editCfg,
      imageProvider: "default",
      summarize,
      store: storeFromState({ version: 0 }),
    });
    expect(summarize).not.toHaveBeenCalled();
    expect(out.compacted).toBe(false);
    // Stage 0 still leaned the view: the old dump (bt1) is a placeholder, the
    // recent dump (bt2, within keep) stays verbatim.
    expect(outputOf(out.messages[0])).toBe(elidedToolPlaceholder("dump", 8000));
    expect(outputOf(out.messages[1])).toBe("Z".repeat(8000));
  });

  it("without context editing the same chat triggers summarization", async () => {
    const summarize = vi.fn(async () => "SUMMARY");
    const out = await applyTier1Compaction({
      chatId: "c",
      messages: messages(),
      state,
      budget,
      config: cfg({
        contextEditingEnabled: false,
        keepRecentMessages: 2,
        minPrunableChars: 100000,
      }),
      imageProvider: "default",
      summarize,
      store: storeFromState({ version: 0 }),
    });
    expect(summarize).toHaveBeenCalledOnce();
    expect(out.compacted).toBe(true);
  });
});
