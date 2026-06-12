/**
 * Context compaction (context-compaction-plan §C/§D, ADR-0009).
 *
 * This module owns durable compaction state and the message-shaping primitives.
 * Slice 2a (this section) is the **single durable writer** (principle P3): every
 * mutation of `summaryWatermark` / `contextSummary` / `compactionDirty` flows
 * through {@link CompactionStore.casWrite}, a version-gated compare-and-swap.
 *
 * Why versioned CAS and not "compare the watermark value" (drift R1): history
 * edits (§C invalidation) move the watermark **backward**. A loser that compared
 * watermark values could mistake a reset for "not yet advanced" and write a stale
 * summary over mutated history. Deciding by `version` removes the monotonicity
 * assumption entirely — any concurrent mutation bumps the version, so a racing
 * write simply loses the CAS and re-reads the truth.
 */

import { and, eq } from "drizzle-orm";
import type { ModelMessage, PrepareStepFunction } from "ai";
import { db } from "../index.ts";
import { chat as chatTable } from "../db/schema.ts";
import { logger } from "../logger.ts";
import type { PlatypusUIMessage } from "../types.ts";
import {
  estimateTokens,
  stableStringify,
  uiMessagesToCountUnits,
  modelMessagesToCountUnits,
  CHARS_PER_TOKEN,
  type ImageProvider,
} from "./token-estimate.ts";

/** Durable compaction state on the chat row. */
export type CompactionState = {
  version: number;
  summaryWatermark: string | null;
  contextSummary: string | null;
  compactionDirty: boolean;
};

/**
 * A patch to the compaction fields. Only the keys present are written; absent
 * keys are left untouched. `version` is always bumped by the writer (not here).
 */
export type WatermarkPatch = {
  watermark?: string | null;
  summary?: string | null;
  dirty?: boolean;
};

/**
 * The durable-state seam. Production wires this to Drizzle
 * ({@link drizzleCompactionStore}); tests pass an in-memory implementation so
 * the CAS algorithm is exercised without Postgres.
 */
export type CompactionStore = {
  readState(chatId: string): Promise<CompactionState | null>;
  /**
   * Version-gated compare-and-swap. Applies `patch` and sets
   * `version = expectVersion + 1` **only if** the row's current version still
   * equals `expectVersion`. Returns true iff exactly one row was updated
   * (i.e. this writer won). The single durable writer (P3).
   */
  casWrite(
    chatId: string,
    expectVersion: number,
    patch: WatermarkPatch,
  ): Promise<boolean>;
};

export const drizzleCompactionStore: CompactionStore = {
  async readState(chatId) {
    const rows = await db
      .select({
        version: chatTable.version,
        summaryWatermark: chatTable.summaryWatermark,
        contextSummary: chatTable.contextSummary,
        compactionDirty: chatTable.compactionDirty,
      })
      .from(chatTable)
      .where(eq(chatTable.id, chatId))
      .limit(1);
    return rows[0] ?? null;
  },

  async casWrite(chatId, expectVersion, patch) {
    const set: Record<string, unknown> = {
      version: expectVersion + 1,
      updatedAt: new Date(),
    };
    // Only touch the fields named in the patch — `in` so an explicit null
    // (clear summary / reset watermark) is distinguishable from "leave alone".
    if ("watermark" in patch) set.summaryWatermark = patch.watermark;
    if ("summary" in patch) set.contextSummary = patch.summary;
    if ("dirty" in patch) set.compactionDirty = patch.dirty;

    const updated = await db
      .update(chatTable)
      .set(set)
      .where(
        and(eq(chatTable.id, chatId), eq(chatTable.version, expectVersion)),
      )
      .returning({ id: chatTable.id });
    return updated.length === 1;
  },
};

/** Outcome of {@link commitWatermark}. */
export type CommitResult =
  | { status: "applied"; version: number }
  | { status: "skipped"; reason: "no-op" | "covered" | "contended" };

/**
 * Decision an attempt makes against the freshly-read state: either write a patch
 * or skip (a no-op, or because a concurrent winner already covered this work).
 */
export type WatermarkDecision =
  | { kind: "write"; patch: WatermarkPatch }
  | { kind: "skip"; reason: "no-op" | "covered" };

/**
 * The single entry point for mutating compaction state (P3, drift T10).
 *
 * Reads the current state, asks `decide` what to do, and CAS-writes it. On a
 * CAS conflict it re-reads and retries the decision **once**; a second conflict
 * terminates as `skipped: "contended"` — never a recompute loop, so there is no
 * livelock. Because `decide` is re-run against the re-read state, a racing
 * invalidation (which bumps version + resets the watermark) is seen on the
 * retry, and `decide` can choose to skip rather than write a stale summary.
 *
 * `decide` returning `skip: "covered"` means a winner already did this work; the
 * caller should pass a patch that also clears `compactionDirty` in that branch
 * if it wants the flag cleared (it is just another field on the patch).
 */
export async function commitWatermark(
  store: CompactionStore,
  chatId: string,
  decide: (state: CompactionState) => WatermarkDecision,
): Promise<CommitResult> {
  const MAX_ATTEMPTS = 2;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const state = await store.readState(chatId);
    if (!state) return { status: "skipped", reason: "no-op" };

    const decision = decide(state);
    if (decision.kind === "skip") {
      return { status: "skipped", reason: decision.reason };
    }

    const won = await store.casWrite(chatId, state.version, decision.patch);
    if (won) return { status: "applied", version: state.version + 1 };
    // Lost the CAS — a concurrent writer moved the version. Loop to re-read and
    // re-decide. The decision compares VERSION (via the re-read), not watermark
    // values, so a backward watermark reset cannot be misread (R1). The metric
    // gates whether the R4 read→summarize→write contention note ever needs a fix.
    logger.info(
      { metric: "cas.conflict", chatId, attempt, version: state.version },
      "cas.conflict",
    );
  }

  logger.warn(
    { metric: "cas.conflict", chatId, contended: true },
    "compaction CAS contended past retry — skipping (safe no-op)",
  );
  return { status: "skipped", reason: "contended" };
}

// ===========================================================================
// Slice 2b — compaction primitives (the message-shaping leaves)
//
// Two adapters share the same staged, cheap-first strategy (LibreChat pattern):
//   Stage 1 — prune bulky tool results (no model call). Often enough.
//   Stage 2 — summarize the older prefix into one synthetic summary (model call).
// `compactUIMessages` (Tier 1, durable) and `compactModelMessages` (Tier 2 +
// recovery, throwaway) differ only in message shape and the tool-pairing rule.
// Token counting is the ONE estimator from token-estimate.ts (P2).
// ===========================================================================

/** Summarizes a transcript into a compact paragraph. Injected (the task model). */
export type Summarize = (text: string) => Promise<string>;

/** Rough token count of a bare string (summary text) — the same char/4 rule. */
function textTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Soft-trims an over-long string to head+tail with an elision marker, so a bulky
 * tool result keeps some signal instead of vanishing entirely.
 */
export function softTrim(text: string, keepEachSide = 500): string {
  if (text.length <= keepEachSide * 2) return text;
  const head = text.slice(0, keepEachSide);
  const tail = text.slice(-keepEachSide);
  const elided = text.length - keepEachSide * 2;
  return `${head}\n…[elided ${elided} chars]…\n${tail}`;
}

/**
 * Picks the index splitting `prefix = [0, boundary)` from `recent = [boundary,
 * total)`. Starts at `total - keepRecent`, then walks backward while the
 * boundary is unsafe so a tool-call/result pair is never split (drift in §C).
 */
export function pickKeepBoundary(
  total: number,
  keepRecent: number,
  isSafeBoundary: (index: number) => boolean,
): number {
  let boundary = Math.max(0, total - keepRecent);
  while (boundary > 0 && !isSafeBoundary(boundary)) boundary--;
  return boundary;
}

// --- Tier 1: UIMessage shape ---------------------------------------------

/**
 * Prunes bulky tool-result outputs in a UIMessage in place on a shallow copy.
 * The tool part is kept (never dropped — the assistant tool message is atomic,
 * §C); only its `output` is soft-trimmed. Returns the (possibly) pruned message.
 */
function pruneUIMessage(
  message: PlatypusUIMessage,
  minPrunableChars: number,
): { message: PlatypusUIMessage; changed: boolean } {
  let changed = false;
  const parts = (message.parts ?? []).map((part) => {
    const anyPart = part as { type: string; output?: unknown };
    const isTool =
      anyPart.type === "dynamic-tool" || anyPart.type.startsWith("tool-");
    if (!isTool || anyPart.output === undefined) return part;
    const serialized =
      typeof anyPart.output === "string"
        ? anyPart.output
        : JSON.stringify(anyPart.output);
    if (serialized.length <= minPrunableChars) return part;
    changed = true;
    return { ...anyPart, output: softTrim(serialized) };
  });
  return changed
    ? { message: { ...message, parts } as PlatypusUIMessage, changed }
    : { message, changed };
}

/** Builds a readable transcript of UIMessages for the summarizer. */
function renderUIMessages(messages: PlatypusUIMessage[]): string {
  return messages
    .map((m) => {
      const text = (m.parts ?? [])
        .map((p) => {
          const ap = p as { type: string; text?: string; output?: unknown };
          if (ap.type === "text") return ap.text ?? "";
          if (ap.type === "dynamic-tool" || ap.type.startsWith("tool-")) {
            const out =
              typeof ap.output === "string"
                ? ap.output
                : ap.output !== undefined
                  ? JSON.stringify(ap.output)
                  : "";
            return `[tool ${ap.type}] ${softTrim(out, 200)}`;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
      return `${m.role}: ${text}`;
    })
    .join("\n\n");
}

export type UICompactOptions = {
  /** Reduce the model view to at most this many tokens (hysteresis target). */
  targetTokens: number;
  keepRecentMessages: number;
  minPrunableChars: number;
  imageProvider?: ImageProvider;
  /** Existing durable summary to fold the new prefix into (incremental). */
  priorSummary?: string | null;
  summarize: Summarize;
  /** Token budget of one summarize call; larger prefixes are map-reduced (M1). */
  summarizerWindow?: number;
  /**
   * Bypass the no-op estimate gate and force compaction even when char/4 says
   * we are within budget. Used for dirty-forced Tier 1 (§E/RV3): recovery sets
   * the dirty flag AFTER a provider rejection, so the estimator already failed;
   * re-using it as the no-op gate causes an infinite overflow→dirty→no-op loop.
   */
  force?: boolean;
  /**
   * Pre-computed estimate of `messages` (RV9). The caller's trigger projection
   * already ran the char/4 pass over this exact set, so reuse it instead of
   * re-estimating the full history a second time on the hot path.
   */
  knownEstimate?: number;
};

export type UICompactionResult = {
  /** Messages to send to the model (recent verbatim; pruned prefix if no summary). */
  keptMessages: PlatypusUIMessage[];
  /** New folded summary, or unchanged prior summary, or null. */
  summaryText: string | null;
  /** Id of the last message folded into the summary (the new watermark), or null. */
  watermarkId: string | null;
  messagesDropped: number;
  usedModelCall: boolean;
  /** Post-compaction estimate incl. the summary — should be ≤ targetTokens (C2). */
  estimatedTokens: number;
};

/**
 * Summarizes a prefix transcript, map-reducing when it exceeds the summarizer's
 * own window (drift M1 — a huge cold-start history can't be sent whole).
 */
async function summarizePrefix(
  prefixText: string,
  priorSummary: string | null | undefined,
  summarize: Summarize,
  summarizerWindow: number | undefined,
): Promise<string> {
  const fold = (prior: string | null | undefined, body: string) =>
    prior ? `Previous summary:\n${prior}\n\nNewer messages:\n${body}` : body;

  if (!summarizerWindow || textTokens(prefixText) <= summarizerWindow) {
    return summarize(fold(priorSummary, prefixText));
  }

  // Map-reduce: chunk the prefix by character budget, summarize each, then
  // summarize the concatenated chunk summaries folded with the prior summary.
  const charBudget = summarizerWindow * CHARS_PER_TOKEN;
  const chunks: string[] = [];
  for (let i = 0; i < prefixText.length; i += charBudget) {
    chunks.push(prefixText.slice(i, i + charBudget));
  }
  const chunkSummaries: string[] = [];
  for (const chunk of chunks) chunkSummaries.push(await summarize(chunk));
  return summarize(fold(priorSummary, chunkSummaries.join("\n")));
}

/**
 * Tier 1 (durable) compaction over UIMessages. Stage 1 prunes; if that reaches
 * the target, no model call is made and the prefix stays (lighter). Otherwise
 * Stage 2 summarizes the prefix into one synthetic summary and drops it from the
 * model view. Raw messages are never mutated by the caller (P1 — this returns a
 * view).
 */
export async function compactUIMessages(
  messages: PlatypusUIMessage[],
  opts: UICompactOptions,
): Promise<UICompactionResult> {
  const provider = opts.imageProvider ?? "default";
  const priorTokens = opts.priorSummary ? textTokens(opts.priorSummary) : 0;
  const estimate = (msgs: PlatypusUIMessage[]) =>
    estimateTokens(uiMessagesToCountUnits(msgs, provider));

  // RV9: reuse the caller's already-computed estimate of `messages` rather than
  // re-running the full char/4 pass on the hot path.
  const initialEstimate = opts.knownEstimate ?? estimate(messages);

  // No-op when already within target (incl. the existing summary). This is what
  // makes a follow-up turn after compaction NOT re-fire (hysteresis, C2).
  // Bypassed when `force` is set — recovery sets the dirty flag AFTER a provider
  // rejection, so the estimator already proved wrong; using it as a no-op gate
  // causes an infinite overflow→dirty→no-op loop (RV3).
  if (!opts.force && initialEstimate + priorTokens <= opts.targetTokens) {
    return {
      keptMessages: messages,
      summaryText: opts.priorSummary ?? null,
      watermarkId: null,
      messagesDropped: 0,
      usedModelCall: false,
      estimatedTokens: initialEstimate + priorTokens,
    };
  }

  const boundary = pickKeepBoundary(
    messages.length,
    opts.keepRecentMessages,
    () => true, // UIMessage tool-call+result live in one message — any split is safe
  );
  const prefix = messages.slice(0, boundary);
  const recent = messages.slice(boundary);

  // Stage 1 — prune bulky tool results in the prefix (no model call).
  const prunedPrefix = prefix.map(
    (m) => pruneUIMessage(m, opts.minPrunableChars).message,
  );
  const prunedAll = [...prunedPrefix, ...recent];
  if (!opts.force && estimate(prunedAll) + priorTokens <= opts.targetTokens) {
    return {
      keptMessages: prunedAll,
      summaryText: opts.priorSummary ?? null,
      watermarkId: null, // pruning advances no watermark (no new summary)
      messagesDropped: 0,
      usedModelCall: false,
      estimatedTokens: estimate(prunedAll) + priorTokens,
    };
  }

  // RV4: nothing to summarize when the prefix is empty (history fits within
  // keepRecentMessages). Also bail when the boundary message has no id — we
  // cannot anchor a watermark there, and committing a watermark:null +
  // non-null summary would orphan the summary (viewAfterWatermark ignores
  // contextSummary when the watermark is null, so the previously-summarised
  // prefix reappears every turn).
  const watermarkId =
    prefix.length > 0 ? (prefix[prefix.length - 1].id ?? null) : null;
  if (prefix.length === 0 || watermarkId === null) {
    return {
      keptMessages: prunedAll,
      summaryText: opts.priorSummary ?? null,
      watermarkId: null,
      messagesDropped: 0,
      usedModelCall: false,
      estimatedTokens: estimate(prunedAll) + priorTokens,
    };
  }

  // Stage 2 — summarize the pruned prefix into one synthetic summary.
  const summaryText = await summarizePrefix(
    renderUIMessages(prunedPrefix),
    opts.priorSummary,
    opts.summarize,
    opts.summarizerWindow,
  );

  return {
    keptMessages: recent,
    summaryText,
    watermarkId,
    messagesDropped: prefix.length,
    usedModelCall: true,
    estimatedTokens: estimate(recent) + textTokens(summaryText),
  };
}

// --- Tier 2 / recovery: ModelMessage shape -------------------------------

/** Soft-trims bulky tool-result parts in a ModelMessage (role "tool"). */
function pruneModelMessage(
  message: ModelMessage,
  minPrunableChars: number,
): ModelMessage {
  if (message.role !== "tool" || typeof message.content === "string") {
    return message;
  }
  const content = message.content.map((part) => {
    if (part.type !== "tool-result") return part;
    const output = part.output;
    if (output.type === "text" || output.type === "error-text") {
      if (output.value.length > minPrunableChars) {
        return {
          ...part,
          output: { ...output, value: softTrim(output.value) },
        };
      }
      return part;
    }
    if (output.type === "json" || output.type === "error-json") {
      const serialized = JSON.stringify(output.value);
      if (serialized.length > minPrunableChars) {
        return {
          ...part,
          output: { type: "text" as const, value: softTrim(serialized) },
        };
      }
    }
    // RV5: @ai-sdk/mcp emits {type:"content"} for essentially every MCP tool
    // result. Without this branch Stage 1 reclaims zero tokens from the bulkiest
    // payloads and their text is invisible to the summarizer.
    if (output.type === "content" && Array.isArray(output.value)) {
      type ContentItem = { type: string; text?: string };
      const items = output.value as ContentItem[];
      const text = items
        .filter((i) => i.type === "text")
        .map((i) => i.text ?? "")
        .join("\n");
      const mediaCount = items.filter((i) => i.type !== "text").length;
      const marker = mediaCount > 0 ? `\n[${mediaCount} media item(s)]` : "";
      // Trim the text BEFORE appending the media marker so a huge text payload
      // can never truncate the "[N media item(s)]" signal.
      if (text.length + marker.length > minPrunableChars) {
        return {
          ...part,
          output: {
            type: "content" as const,
            value: [
              { type: "text" as const, text: `${softTrim(text)}${marker}` },
            ],
          },
        };
      }
    }
    return part;
  });
  return { ...message, content };
}

function renderModelMessages(messages: ModelMessage[]): string {
  return messages
    .map((m) => {
      if (typeof m.content === "string") return `${m.role}: ${m.content}`;
      const text = m.content
        .map((p) => {
          if (p.type === "text") return p.text;
          if (p.type === "tool-call") return `[tool-call ${p.toolName}]`;
          if (p.type === "tool-result") {
            const o = p.output;
            let v: string;
            if (o.type === "text" || o.type === "error-text") {
              v = o.value;
            } else if (o.type === "json" || o.type === "error-json") {
              v = JSON.stringify(o.value);
            } else if (o.type === "content") {
              // RV5: extract text items from content-type MCP output (RV5).
              type ContentItem = { type: string; text?: string };
              v = (o.value as ContentItem[])
                .filter((i) => i.type === "text")
                .map((i) => i.text ?? "")
                .join("\n");
            } else {
              v = "";
            }
            return `[tool-result] ${softTrim(v, 200)}`;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
      return `${m.role}: ${text}`;
    })
    .join("\n\n");
}

/** A synthetic summary as a model message. User-role + clear framing is the most
 * broadly accepted shape (avoids mid-array system-message restrictions). */
export function summaryModelMessage(text: string): ModelMessage {
  return {
    role: "user",
    content: [
      { type: "text", text: `[Summary of earlier conversation]\n${text}` },
    ],
  };
}

export type ModelCompactOptions = {
  targetTokens: number;
  keepRecentMessages: number;
  minPrunableChars: number;
  imageProvider?: ImageProvider;
  summarize: Summarize;
  summarizerWindow?: number;
  /** Bypass the no-op estimate gate (same semantics as UICompactOptions.force). */
  force?: boolean;
  /**
   * Estimate of `messages` the caller already computed (e.g. the Tier 2
   * prepareStep trigger check). Reuses it for gate 1 instead of re-running a
   * full estimate pass over the same messages.
   */
  knownEstimate?: number;
};

export type ModelCompactionResult = {
  messages: ModelMessage[];
  messagesDropped: number;
  usedModelCall: boolean;
  estimatedTokens: number;
};

/**
 * Tier 2 (intra-turn) / recovery compaction over ModelMessages. Throwaway — the
 * SDK keeps its canonical list; this only keeps a heavy response executable.
 * Pairing rule differs from Tier 1: an assistant tool-call and its following
 * `role:"tool"` result are separate messages and must not be split.
 */
export async function compactModelMessages(
  messages: ModelMessage[],
  opts: ModelCompactOptions,
): Promise<ModelCompactionResult> {
  const provider = opts.imageProvider ?? "default";
  const estimate = (msgs: ModelMessage[]) =>
    estimateTokens(modelMessagesToCountUnits(msgs, provider));

  const initialEstimate = opts.knownEstimate ?? estimate(messages);
  if (!opts.force && initialEstimate <= opts.targetTokens) {
    return {
      messages,
      messagesDropped: 0,
      usedModelCall: false,
      estimatedTokens: initialEstimate,
    };
  }

  // A boundary is unsafe if it would start `recent` on a tool result orphaned
  // from its assistant tool-call (which would sit in the dropped prefix).
  const boundary = pickKeepBoundary(
    messages.length,
    opts.keepRecentMessages,
    (i) => i >= messages.length || messages[i].role !== "tool",
  );
  const prefix = messages.slice(0, boundary);
  const recent = messages.slice(boundary);

  // Stage 1 — prune.
  const prunedPrefix = prefix.map((m) =>
    pruneModelMessage(m, opts.minPrunableChars),
  );
  const prunedAll = [...prunedPrefix, ...recent];
  // Force-guarded like gate 1 (RV3): when recovery forces a trim the provider
  // already rejected this prompt, so the estimator proved wrong — re-trusting
  // it here would return a byte-identical prompt and burn the single retry.
  if (!opts.force && estimate(prunedAll) <= opts.targetTokens) {
    return {
      messages: prunedAll,
      messagesDropped: 0,
      usedModelCall: false,
      estimatedTokens: estimate(prunedAll),
    };
  }

  // RV4 (model-side): nothing to summarize when the prefix is empty (recent
  // alone exceeds keepRecentMessages). Summarizing an empty prefix would add a
  // synthetic message and GROW the prompt — never converges. Surface the
  // overflow instead (recovery retries once, then propagates).
  if (prefix.length === 0) {
    return {
      messages: prunedAll,
      messagesDropped: 0,
      usedModelCall: false,
      estimatedTokens: estimate(prunedAll),
    };
  }

  // Stage 2 — summarize the pruned prefix into one synthetic message.
  const summaryText = await summarizePrefix(
    renderModelMessages(prunedPrefix),
    null,
    opts.summarize,
    opts.summarizerWindow,
  );
  const compacted = [summaryModelMessage(summaryText), ...recent];
  return {
    messages: compacted,
    messagesDropped: prefix.length,
    usedModelCall: true,
    estimatedTokens: estimate(compacted),
  };
}

// ===========================================================================
// Slice 2c — Tier 1 orchestration (budget, view reconstruction, persist)
//
// `applyTier1Compaction` is the durable, cross-turn entry point invoked from
// `prepareChatTurn`. It is dependency-injected (store + summarizer) so it is
// unit-testable without standing up the full turn machinery. It:
//   1. Reconstructs the compacted VIEW from persisted state every turn (P1) —
//      drop messages up to the watermark, re-inject the stored summary.
//   2. Triggers a fresh compaction when the projected size crosses the trigger
//      ratio, OR when `compactionDirty` forces it (recovery hand-off, §E).
//   3. Persists any new summary/watermark + clears dirty via the single CAS
//      writer (P3), the loser skipping safely on contention (R4).
// ===========================================================================

/** Resolved per-turn compaction config (§G), defaults applied. */
export type CompactionConfig = {
  compactionEnabled: boolean;
  triggerRatio: number;
  targetRatio: number;
  reserveRatio: number;
  keepRecentMessages: number;
  minPrunableChars: number;
};

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  compactionEnabled: true,
  triggerRatio: 0.8,
  targetRatio: 0.5,
  reserveRatio: 0.05,
  keepRecentMessages: 10,
  minPrunableChars: 2000,
};

export type Budget = {
  inputBudget: number;
  triggerTokens: number;
  targetTokens: number;
};

/**
 * Budget math (drift C3): the trigger/target are fractions of the INPUT budget —
 * the window minus the output reservation and a safety headroom — not of the raw
 * window. When the resolved max output is unknown, reserve a conservative slice.
 */
export function computeBudget(
  contextWindow: number,
  maxOutputTokens: number | undefined,
  config: CompactionConfig,
): Budget {
  const maxOutputReserve =
    maxOutputTokens ?? Math.min(4096, Math.floor(contextWindow * 0.25));
  const safetyReserve = Math.floor(config.reserveRatio * contextWindow);
  const inputBudget = Math.max(
    1,
    contextWindow - maxOutputReserve - safetyReserve,
  );
  return {
    inputBudget,
    triggerTokens: config.triggerRatio * inputBudget,
    targetTokens: config.targetRatio * inputBudget,
  };
}

/**
 * First-turn safety margin on the char/4 projection (drift M2): char/4
 * under-counts CJK, dense JSON, and tool chatter, and on a cold start there is
 * no provider-reported `usage.inputTokens` to correct it.
 */
export const COLD_START_MARGIN = 1.15;

/**
 * The Tier 1 trigger projection (drift C1): what THIS turn is about to put on
 * the wire, not just the stored messages. `overheadTokens` carries the
 * estimated system prompt + tool schemas + skill payload — invisible to a
 * message-only estimate but sent to the model on every turn (the observed
 * live-test gap: provider reported 8888 input tokens vs ~986 message-only).
 * `lastInputTokens` is the provider-reported count from the prior turn — the
 * corrective baseline for turns ≥ 2 (threaded in the §H usage-metadata chunk).
 * When it is absent the whole char/4 projection is inflated by
 * {@link COLD_START_MARGIN} (M2).
 */
export function projectTier1Tokens(args: {
  messageTokens: number;
  priorSummaryTokens: number;
  overheadTokens?: number;
  lastInputTokens?: number;
}): number {
  const charBased =
    args.messageTokens + args.priorSummaryTokens + (args.overheadTokens ?? 0);
  if (args.lastInputTokens == null) {
    return Math.ceil(charBased * COLD_START_MARGIN);
  }
  // Two independent estimates of this turn's payload: `charBased` is a fresh
  // char/4 pass over the whole unsummarized view (+ summary + overhead);
  // `lastInputTokens` is the provider's accurate count from the prior turn but
  // stale (missing messages appended since). Take the larger — char/4 chronically
  // under-counts, so this is usually `lastInputTokens`; over-counting only
  // triggers compaction earlier, never an overflow.
  return Math.max(Math.ceil(charBased), args.lastInputTokens);
}

/** Synthetic UIMessage carrying the persisted summary, injected into the view. */
export function summaryUIMessage(text: string): PlatypusUIMessage {
  return {
    id: "context-summary",
    role: "user",
    parts: [
      { type: "text", text: `[Summary of earlier conversation]\n${text}` },
    ],
  } as PlatypusUIMessage;
}

/** Fail-loud event so the transcript shows compaction happened (§C). */
export type CompactionEvent = {
  type: "context-compacted";
  messagesDropped: number;
  tokensBefore: number;
  tokensAfter: number;
};

export type Tier1Input = {
  chatId: string;
  /** Full durable history (post-`inlineFileUrls`, drift T2). */
  messages: PlatypusUIMessage[];
  state: CompactionState;
  budget: Budget;
  config: CompactionConfig;
  imageProvider: ImageProvider;
  summarize: Summarize;
  store: CompactionStore;
  summarizerWindow?: number;
  /**
   * Estimated tokens of the per-turn payload that is NOT in `messages` —
   * system prompt, tool schemas, skill list (drift C1). Counted toward the
   * trigger and subtracted from the compaction target (compaction cannot
   * shrink it, so hysteresis must leave room for it — C2).
   */
  overheadTokens?: number;
  /** Provider-reported `usage.inputTokens` from the prior turn (C1, via §H). */
  lastInputTokens?: number;
  onEvent?: (event: CompactionEvent) => void;
};

export type CompactionTrace = {
  /** Number of messages that were folded into the summary. */
  messagesDropped: number;
  /** First ~120 chars of the LLM-generated summary. */
  summaryExcerpt?: string;
};

/** Tool name for the synthetic compaction-trace tool-call/result pair (§K/11c).
 * Shared by the stream-trace producer (agent-runner), the strip filter that
 * keeps it out of the model payload, the §J persisted-message builder, and the
 * frontend display-name mapping. */
export const COMPACT_CONTEXT_TOOL_NAME = "compact_context";

/** Builds a standalone synthetic assistant message carrying the compaction
 * trace as a `compact_context` tool-call/result pair (§J — forced compaction
 * has no live stream to inject into, so the trace is persisted as its own
 * message instead). The message is always appended ABOVE the watermark, so it
 * is never itself summarized; the strip filter keeps it out of the model
 * payload on subsequent turns. */
export function buildCompactionTraceMessage(
  trace: CompactionTrace,
  id: string,
): PlatypusUIMessage {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: `tool-${COMPACT_CONTEXT_TOOL_NAME}`,
        toolCallId: `${id}-call`,
        state: "output-available",
        input: { messagesDropped: trace.messagesDropped },
        output: {
          messagesDropped: trace.messagesDropped,
          ...(trace.summaryExcerpt
            ? { summaryExcerpt: trace.summaryExcerpt }
            : {}),
        },
      },
    ],
  } as unknown as PlatypusUIMessage;
}

export type Tier1Output = {
  /** The compacted view to send to the model (summary message + recent). */
  messages: PlatypusUIMessage[];
  /** True when a new summary was produced and persisted this turn. */
  compacted: boolean;
  commit?: CommitResult;
  /**
   * Present ONLY when a model summary was produced this turn — the user-visible
   * "compaction happened" signal (§K/11c). Deliberately undefined for
   * prune-only and force-dirty-within-target no-op turns: those drop 0 messages
   * and have no excerpt, so a trace would render an empty/confusing timeline
   * entry.
   */
  compactionTrace?: CompactionTrace;
};

/** Splits history at the watermark message id. Returns the messages after it and
 * whether the stored summary is still trustworthy (watermark id still present). */
function viewAfterWatermark(
  messages: PlatypusUIMessage[],
  state: CompactionState,
): { afterWatermark: PlatypusUIMessage[]; priorSummary: string | null } {
  if (!state.summaryWatermark) {
    return { afterWatermark: messages, priorSummary: null };
  }
  const idx = messages.findIndex((m) => m.id === state.summaryWatermark);
  if (idx === -1) {
    // Watermark message is gone (edited/deleted before invalidation landed):
    // distrust the summary and fall back to the full history (defensive C4).
    return { afterWatermark: messages, priorSummary: null };
  }
  return {
    afterWatermark: messages.slice(idx + 1),
    priorSummary: state.contextSummary,
  };
}

export async function applyTier1Compaction(
  input: Tier1Input,
): Promise<Tier1Output> {
  const { messages, state, budget, config, imageProvider } = input;
  const estimate = (msgs: PlatypusUIMessage[]) =>
    estimateTokens(uiMessagesToCountUnits(msgs, imageProvider));

  const { afterWatermark, priorSummary } = viewAfterWatermark(messages, state);
  const priorSummaryTokens = priorSummary ? textTokens(priorSummary) : 0;

  const inject = (summary: string | null, msgs: PlatypusUIMessage[]) =>
    summary ? [summaryUIMessage(summary), ...msgs] : msgs;

  // The view that would be sent if we did nothing more this turn.
  const baseView = inject(priorSummary, afterWatermark);
  const overheadTokens = input.overheadTokens ?? 0;
  // RV9: compute the char/4 pass over the unsummarized view once and reuse it
  // for both the trigger projection and compactUIMessages' no-op gate.
  const messageTokens = estimate(afterWatermark);
  const projected = projectTier1Tokens({
    messageTokens,
    priorSummaryTokens,
    overheadTokens,
    lastInputTokens: input.lastInputTokens,
  });

  const forceCompact = state.compactionDirty;
  const triggered =
    forceCompact ||
    (config.compactionEnabled && projected >= budget.triggerTokens);

  if (!triggered) {
    return { messages: baseView, compacted: false };
  }

  // Compaction can only shrink the messages, never the per-turn overhead, so
  // the target the messages must fit in is reduced by it (C1/C2). When the
  // overhead alone exhausts the target, hysteresis is impossible — warn loudly
  // (compaction will re-fire every turn) but still compact: recovery is the
  // only other net.
  const effectiveTarget = Math.max(0, budget.targetTokens - overheadTokens);
  if (overheadTokens >= budget.targetTokens) {
    logger.warn(
      { chatId: input.chatId, overheadTokens, target: budget.targetTokens },
      "system/tool overhead alone exceeds the compaction target — compaction will re-fire each turn",
    );
  }

  const result = await compactUIMessages(afterWatermark, {
    targetTokens: effectiveTarget,
    keepRecentMessages: config.keepRecentMessages,
    minPrunableChars: config.minPrunableChars,
    imageProvider,
    priorSummary,
    summarize: input.summarize,
    summarizerWindow: input.summarizerWindow,
    // When dirty-forced the estimator already proved wrong (RV3): bypass the
    // no-op gate so recovery's dirty flag actually shrinks the history.
    force: forceCompact,
    // RV9: the no-op gate estimates this exact set; reuse the value above.
    knownEstimate: messageTokens,
  });

  const view = inject(result.summaryText ?? priorSummary, result.keptMessages);

  // Persist through the single CAS writer (P3). The decision is gated on the
  // version we read; if a concurrent writer advanced it, we skip rather than
  // recompute (R4 — the wasted summarize is bounded, never corrupting). The
  // version-pinning gate is shared so both write paths decide identically.
  const capturedVersion = state.version;
  const pinnedWrite = (patch: WatermarkPatch) =>
    commitWatermark(input.store, input.chatId, (latest) =>
      latest.version === capturedVersion
        ? { kind: "write", patch }
        : { kind: "skip", reason: "covered" },
    );
  let commit: CommitResult | undefined;

  if (result.usedModelCall) {
    commit = await pinnedWrite({
      summary: result.summaryText,
      watermark: result.watermarkId,
      dirty: false,
    });
    logger.info(
      {
        metric: "compaction.fired",
        tier: 1,
        chatId: input.chatId,
        tokensBefore: projected,
        tokensAfter: result.estimatedTokens,
        messagesDropped: result.messagesDropped,
      },
      "compaction.fired",
    );
    input.onEvent?.({
      type: "context-compacted",
      messagesDropped: result.messagesDropped,
      tokensBefore: projected,
      tokensAfter: result.estimatedTokens,
    });
  } else if (state.compactionDirty) {
    // Forced by recovery but pruning/within-target sufficed: just clear the flag.
    commit = await pinnedWrite({ dirty: false });
  }

  // Only surface a trace when an actual model summary was produced. Prune-only
  // and force-dirty-within-target runs drop 0 messages with no excerpt — a
  // trace there would be an empty, confusing timeline entry (§K/11c).
  const compactionTrace: CompactionTrace | undefined =
    result.usedModelCall && result.summaryText
      ? {
          messagesDropped: result.messagesDropped,
          summaryExcerpt: result.summaryText.slice(0, 120),
        }
      : undefined;

  return {
    messages: view,
    compacted: result.usedModelCall,
    commit,
    compactionTrace,
  };
}

/**
 * Detects which summarized messages (at/below the watermark) the freshly
 * submitted history changed or dropped — the C4 trigger. Because the client
 * resubmits the full message array each turn (there is no separate edit/delete
 * endpoint), divergence is found by comparing the persisted canonical history
 * against the incoming one up to the watermark. Returns the ids that an
 * edit/delete/regenerate touched; empty means the summary is still valid.
 */
export function affectedBelowWatermark(
  persisted: PlatypusUIMessage[],
  incoming: PlatypusUIMessage[],
  watermarkId: string | null,
): string[] {
  if (!watermarkId) return [];
  const wmIdx = persisted.findIndex((m) => m.id === watermarkId);
  if (wmIdx === -1) return [watermarkId]; // watermark message gone entirely
  const incomingById = new Map(incoming.map((m) => [m.id, m]));
  const affected: string[] = [];
  for (let i = 0; i <= wmIdx; i++) {
    const p = persisted[i];
    if (!p.id) continue;
    const inc = incomingById.get(p.id);
    if (!inc || stableStringify(inc.parts) !== stableStringify(p.parts)) {
      affected.push(p.id);
    }
  }
  return affected;
}

/**
 * Persists `compactionDirty = true` after a context-overflow recovery (§E,
 * drift T3). Recovery never writes summary/watermark — it only flags; the next
 * `prepareChatTurn` sees the flag, forces Tier 1, and clears it inside the same
 * CAS write that advances the watermark. Goes through the single writer (P3);
 * already-dirty is a no-op.
 */
export async function setCompactionDirty(
  store: CompactionStore,
  chatId: string,
): Promise<CommitResult> {
  return commitWatermark(store, chatId, (state) =>
    state.compactionDirty
      ? { kind: "skip", reason: "no-op" }
      : { kind: "write", patch: { dirty: true } },
  );
}

export async function invalidateCompaction(
  store: CompactionStore,
  chatId: string,
  affectedIds: string[],
  orderedIds: string[],
): Promise<CommitResult> {
  return commitWatermark(store, chatId, (state) => {
    if (!state.summaryWatermark && !state.contextSummary) {
      return { kind: "skip", reason: "no-op" };
    }
    const wmIndex = state.summaryWatermark
      ? orderedIds.indexOf(state.summaryWatermark)
      : orderedIds.length; // null watermark ⇒ everything is "summarized-from-start"
    const affectsSummarized = affectedIds.some((id) => {
      const i = orderedIds.indexOf(id);
      // Affected message is missing (deleted) or sits at/below the watermark.
      return i === -1 || (wmIndex !== -1 && i <= wmIndex);
    });
    if (!affectsSummarized) return { kind: "skip", reason: "no-op" };
    return { kind: "write", patch: { summary: null, watermark: null } };
  });
}

// --- Tier 2 in-turn compaction (§D, ADR-0009) ---

/**
 * Per-turn Tier 2 compaction context (§D). Null when the §G kill switch or
 * agent config disables proactive compaction. Sub-agents also receive Tier 2
 * (drift M3 — they have no durable history for Tier 1, but their tool loop
 * can bloat intra-turn).
 */
export type Tier2Context = {
  triggerTokens: number;
  targetTokens: number;
  keepRecentMessages: number;
  minPrunableChars: number;
  imageProvider: ImageProvider;
  summarize: Summarize;
  summarizerWindow?: number;
};

/**
 * Builds the Tier 2 in-turn compaction `prepareStep` callback (§D). Fires
 * before each step of a tool loop when the accumulated model messages exceed
 * `triggerTokens` — compacts via `compactModelMessages` and returns the
 * trimmed messages. Returns `undefined` when below the threshold so the SDK
 * proceeds unchanged (drift m3: no per-step overhead when the loop is small).
 */
export function buildTier2PrepareStep(ctx: Tier2Context): PrepareStepFunction {
  return async ({ messages }) => {
    const estimate = estimateTokens(
      modelMessagesToCountUnits(messages, ctx.imageProvider),
    );
    if (estimate < ctx.triggerTokens) return undefined;

    const result = await compactModelMessages(messages, {
      targetTokens: ctx.targetTokens,
      keepRecentMessages: ctx.keepRecentMessages,
      minPrunableChars: ctx.minPrunableChars,
      imageProvider: ctx.imageProvider,
      summarize: ctx.summarize,
      summarizerWindow: ctx.summarizerWindow,
      // Reuse the trigger-check estimate; skips a redundant full pass (RV9).
      knownEstimate: estimate,
    });

    if (result.messagesDropped === 0) return undefined;

    logger.info(
      {
        messagesDropped: result.messagesDropped,
        estimatedTokensBefore: estimate,
        estimatedTokensAfter: result.estimatedTokens,
      },
      "Tier 2 in-turn compaction fired",
    );

    return { messages: result.messages };
  };
}
