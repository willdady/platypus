import { describe, it, expect, vi } from "vitest";

vi.mock("../index.ts", () => ({ db: {} })); // drizzle store unused in these tests
vi.mock("../logger.ts", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  commitWatermark,
  compactUIMessages,
  compactModelMessages,
  pickKeepBoundary,
  softTrim,
  type CompactionStore,
  type CompactionState,
  type WatermarkPatch,
} from "./compaction.ts";
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
  computeBudget,
  resolveCompactionConfig,
  invalidateCompaction,
  affectedBelowWatermark,
  summaryUIMessage,
  DEFAULT_COMPACTION_CONFIG,
  type Budget,
  type CompactionConfig,
} from "./compaction.ts";

function storeFromState(state: Partial<CompactionState>): FakeStore {
  return new FakeStore(state);
}

const cfg = (over: Partial<CompactionConfig> = {}): CompactionConfig => ({
  ...DEFAULT_COMPACTION_CONFIG,
  keepRecentMessages: 2,
  ...over,
});

describe("resolveCompactionConfig (§G defaults)", () => {
  it("returns defaults when overrides are null/undefined", () => {
    expect(resolveCompactionConfig(null)).toEqual(DEFAULT_COMPACTION_CONFIG);
  });
  it("applies partial overrides, keeping defaults for the rest", () => {
    const c = resolveCompactionConfig({
      triggerRatio: 0.9,
      compactionEnabled: false,
    });
    expect(c.triggerRatio).toBe(0.9);
    expect(c.compactionEnabled).toBe(false);
    expect(c.targetRatio).toBe(DEFAULT_COMPACTION_CONFIG.targetRatio);
  });
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
