/**
 * Context compaction (ADR-0012 §Tier 1 / §Tier 2).
 *
 * This module owns durable compaction state and the message-shaping primitives.
 * Slice 2a (this section) is the **single durable writer** (principle ADR-0012 §One durable writer): every
 * mutation of `summaryWatermark` / `contextSummary` / `compactionDirty` flows
 * through {@link CompactionStore.casWrite}, a version-gated compare-and-swap.
 *
 * Why versioned CAS and not "compare the watermark value" (ADR-0012 §One durable writer): history
 * edits (ADR-0012 §Tier 1 invalidation) move the watermark **backward**. A loser that compared
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
   * (i.e. this writer won). The single durable writer (ADR-0012 §One durable writer).
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
 * The single entry point for mutating compaction state (ADR-0012 §One durable writer).
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
    // values, so a backward watermark reset cannot be misread (ADR-0012 §One durable writer). The metric
    // gates whether the read→summarize→write contention note ever needs a fix.
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
// Token counting is the ONE estimator from token-estimate.ts (ADR-0012 §One estimator).
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
 * boundary is unsafe so a tool-call/result pair is never split (ADR-0012 §Tier 1).
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
 * ADR-0012 §Tier 1); only its `output` is soft-trimmed. Returns the (possibly) pruned message.
 *
 * With `includeText`, also soft-trims oversized `text` parts (e.g. a large
 * assistant code answer): the keep-window otherwise protects such answers from
 * summarization, so a couple of large recent answers can dominate the window and
 * never get condensed. Trimming them is view-only (raw stays in the DB per
 * ADR-0012 §View, not delete). Off by default so the prefix/Stage-1 path that
 * feeds the summarizer verbatim is unaffected — only the retained-message
 * wall-trim opts in.
 */
function pruneUIMessage(
  message: PlatypusUIMessage,
  minPrunableChars: number,
  opts: { includeText?: boolean } = {},
): { message: PlatypusUIMessage; changed: boolean } {
  let changed = false;
  const parts = (message.parts ?? []).map((part) => {
    const anyPart = part as { type: string; output?: unknown; text?: unknown };
    const isTool =
      anyPart.type === "dynamic-tool" || anyPart.type.startsWith("tool-");
    if (isTool && anyPart.output !== undefined) {
      const serialized =
        typeof anyPart.output === "string"
          ? anyPart.output
          : JSON.stringify(anyPart.output);
      if (serialized.length <= minPrunableChars) return part;
      changed = true;
      return { ...anyPart, output: softTrim(serialized) };
    }
    // Oversized text parts (opt-in via includeText).
    if (
      opts.includeText &&
      anyPart.type === "text" &&
      typeof anyPart.text === "string" &&
      anyPart.text.length > minPrunableChars
    ) {
      changed = true;
      return { ...anyPart, text: softTrim(anyPart.text) };
    }
    return part;
  });
  return changed
    ? { message: { ...message, parts } as PlatypusUIMessage, changed }
    : { message, changed };
}

/**
 * Placeholder body for an elided tool result (ADR-0012 §Stage 0 — context editing).
 * LLM-AGNOSTIC: Platypus may run small/weak background models, so the string is
 * EXPLICIT and self-describing. A terse marker ("[Old tool result content
 * cleared]") assumes the model infers it can re-call the tool; a small model may
 * not. Names the tool + elided size so the model can decide to re-run it, and is
 * short enough that Stage 1 / the hard window wall never re-trim it.
 */
const ELIDED_PLACEHOLDER_PREFIX = '[Tool result for "';

export function elidedToolPlaceholder(toolName: string, chars: number): string {
  return `${ELIDED_PLACEHOLDER_PREFIX}${toolName}" omitted to save context (${chars} chars). The full result is still available — call the tool again with the same input if you need it.]`;
}

export type EditToolResultsOptions = {
  /** Exempt the last N tool results (most recent) from elision. */
  keepRecentToolResults: number;
  /** Only elide a tool result whose serialized output exceeds this many chars. */
  minEditableToolChars: number;
};

export type EditToolResultsResult = {
  messages: PlatypusUIMessage[];
  resultsElided: number;
  /** Net chars removed (original output length − placeholder length), for metrics. */
  charsReclaimed: number;
};

/**
 * Stage 0 (ADR-0012 §Stage 0 — context editing; Anthropic `clear_tool_uses`
 * equivalent): replaces the `output` of OLD bulky tool-result parts with a short
 * placeholder, keeping the tool part itself (pairing) and ALL text parts intact.
 * Pure + deterministic — no model call, recomputed from raw messages each turn by
 * recency, so it needs no durable state (ADR-0012 §View, not delete: raw `chat.messages` is untouched, the
 * full result stays for UI/audit).
 *
 * Recency is by COUNT of tool results (we have no clean turn id): the last
 * `keepRecentToolResults` results are exempt, and the newest message is exempt
 * regardless (same invariant as ADR-0012 §Hard window wall). A result is elided only when
 * its serialized `output` exceeds `minEditableToolChars` — the size gate ≈
 * Anthropic's `clear_at_least`, so trivial results never churn the prompt cache.
 *
 * Monotonic + deterministic ⇒ cache-friendly: a result is elided the turn it ages
 * past the keep-window and stays elided. Returns the SAME array reference when
 * nothing qualified, so callers can skip a re-estimate.
 */
export function editToolResults(
  messages: PlatypusUIMessage[],
  opts: EditToolResultsOptions,
): EditToolResultsResult {
  // Enumerate every tool-result-bearing part in order so "keep the last N" is a
  // simple tail slice. A single message can carry several tool parts.
  const toolResultLocs: Array<{ mi: number; pi: number }> = [];
  messages.forEach((m, mi) => {
    (m.parts ?? []).forEach((part, pi) => {
      const ap = part as { type: string; output?: unknown };
      const isTool = ap.type === "dynamic-tool" || ap.type.startsWith("tool-");
      if (isTool && ap.output !== undefined) toolResultLocs.push({ mi, pi });
    });
  });

  // Candidates for elision = all but the last `keepRecentToolResults`; the newest
  // MESSAGE is exempt regardless (ADR-0012 §Hard window wall invariant). Decide the
  // FULL elision policy here (recency + size gate + idempotency + grow-guard) and
  // record the precomputed placeholder, so the rewrite map below fires only when
  // there is real work — and never allocates a copy for a pure no-op.
  const keepFrom = Math.max(
    0,
    toolResultLocs.length - opts.keepRecentToolResults,
  );
  const newestMessageIndex = messages.length - 1;
  const elideAt = new Map<string, string>(); // "mi:pi" -> placeholder
  let charsReclaimed = 0;
  for (let k = 0; k < keepFrom; k++) {
    const loc = toolResultLocs[k];
    if (loc.mi === newestMessageIndex) continue; // newest message exempt
    const ap = (messages[loc.mi].parts ?? [])[loc.pi] as {
      type: string;
      output?: unknown;
      toolName?: string;
    };
    const serialized =
      typeof ap.output === "string" ? ap.output : JSON.stringify(ap.output);
    // Size gate (≈ clear_at_least): leave trivial results untouched — no churn.
    if (serialized.length <= opts.minEditableToolChars) continue;
    // Idempotency guard: never re-elide our own placeholder. At the default gate
    // (50k) the ~150-char placeholder is far below it, but a misconfigured tiny
    // gate would otherwise re-elide it every turn. Keeps this monotonic.
    if (
      typeof ap.output === "string" &&
      ap.output.startsWith(ELIDED_PLACEHOLDER_PREFIX)
    ) {
      continue;
    }
    const toolName =
      ap.type === "dynamic-tool"
        ? (ap.toolName ?? "unknown")
        : ap.type.slice("tool-".length);
    const placeholder = elidedToolPlaceholder(toolName, serialized.length);
    // Grow-guard: a tiny gate could pick a result shorter than the placeholder;
    // eliding would INFLATE the prompt (negative reclaim). Skip — never grow.
    if (placeholder.length >= serialized.length) continue;
    elideAt.set(`${loc.mi}:${loc.pi}`, placeholder);
    charsReclaimed += serialized.length - placeholder.length;
  }

  // Nothing truly qualified ⇒ return the original reference so callers skip the
  // re-estimate (cache-friendly no-op) and we allocate no copy.
  if (elideAt.size === 0) {
    return { messages, resultsElided: 0, charsReclaimed: 0 };
  }

  const out = messages.map((m, mi) => {
    const parts = m.parts ?? [];
    if (!parts.some((_, pi) => elideAt.has(`${mi}:${pi}`))) return m;
    const newParts = parts.map((part, pi) => {
      const placeholder = elideAt.get(`${mi}:${pi}`);
      if (placeholder === undefined) return part;
      const ap = part as { output?: unknown };
      return { ...ap, output: placeholder };
    });
    return { ...m, parts: newParts } as PlatypusUIMessage;
  });

  return { messages: out, resultsElided: elideAt.size, charsReclaimed };
}

/** Builds a readable transcript of UIMessages for the summarizer. */
/** Renders each message to its own transcript string (one entry per message), so
 * the map-reduce summarizer can chunk on message boundaries and never split a
 * single message mid-content (ADR-0012 §Tier 1 map-reduce). */
function renderUIMessageList(messages: PlatypusUIMessage[]): string[] {
  return messages.map((m) => {
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
  });
}

export type UICompactOptions = {
  /** Reduce the model view to at most this many tokens (hysteresis target). */
  targetTokens: number;
  keepRecentMessages: number;
  minPrunableChars: number;
  /** Threshold for pruning tool results in kept (recent) messages after Stage 2.
   * Defaults to minPrunableChars * 5 when omitted. */
  minRecentPrunableChars?: number;
  /**
   * The HARD window wall (ADR-0012 §Hard window wall): the kept view's tokens
   * above which the call would actually overflow (already net of per-turn
   * overhead by the caller). Recent (kept) tool results are trimmed ONLY when
   * the kept view breaches this wall — a mere `targetTokens` (hysteresis) miss
   * is cheap (it re-compacts next turn) and is not worth gutting active data the
   * user is asking about. The single newest message is always exempt regardless.
   * When omitted, recent results are always trimmed once over target (the
   * behaviour predating ADR-0012 §Hard window wall) — safer than never trimming for callers that cannot
   * supply the wall.
   */
  inputBudget?: number;
  imageProvider?: ImageProvider;
  /** Existing durable summary to fold the new prefix into (incremental). */
  priorSummary?: string | null;
  summarize: Summarize;
  /** Token budget of one summarize call; larger prefixes are map-reduced (ADR-0012 §Tier 1 (summarizer model & map-reduce)). */
  summarizerWindow?: number;
  /**
   * Bypass the no-op estimate gate and force compaction even when char/4 says
   * we are within budget. Used for dirty-forced Tier 1 (ADR-0012 §Recovery): recovery sets
   * the dirty flag AFTER a provider rejection, so the estimator already failed;
   * re-using it as the no-op gate causes an infinite overflow→dirty→no-op loop.
   */
  force?: boolean;
  /**
   * Pre-computed estimate of `messages`. The caller's trigger projection
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
  /** Post-compaction estimate incl. the summary — should be ≤ targetTokens (ADR-0012 §Tier 1 (hysteresis)). */
  estimatedTokens: number;
};

/**
 * Summarizes a prefix transcript, map-reducing when it exceeds the summarizer's
 * own window (ADR-0012 §Tier 1 (summarizer model & map-reduce) — a huge cold-start history can't be sent whole).
 */
/**
 * Packs per-message transcript segments into chunks that each fit `windowTokens`,
 * splitting only on MESSAGE boundaries — never mid-message. A lone segment larger
 * than the window (a single oversized message) is char-sliced as a last resort,
 * which is unavoidable for one message that cannot fit whole.
 */
function packSegments(segments: string[], windowTokens: number): string[] {
  const chunks: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur) {
      chunks.push(cur);
      cur = "";
    }
  };
  for (const seg of segments) {
    if (textTokens(seg) > windowTokens) {
      flush();
      const charBudget = windowTokens * CHARS_PER_TOKEN;
      for (let i = 0; i < seg.length; i += charBudget) {
        chunks.push(seg.slice(i, i + charBudget));
      }
      continue;
    }
    const next = cur ? `${cur}\n\n${seg}` : seg;
    if (textTokens(next) > windowTokens) {
      flush();
      cur = seg;
    } else {
      cur = next;
    }
  }
  flush();
  return chunks;
}

async function summarizePrefix(
  segments: string[],
  priorSummary: string | null | undefined,
  summarize: Summarize,
  summarizerWindow: number | undefined,
): Promise<string> {
  const fold = (prior: string | null | undefined, body: string) =>
    prior ? `Previous summary:\n${prior}\n\nNewer messages:\n${body}` : body;

  // Single pass when everything — prior summary AND fold framing included —
  // fits the window. Checking the *folded* size (not the bare body) closes the
  // gap where a large prior summary overflowed an otherwise-fitting prefix.
  const joined = segments.join("\n\n");
  if (
    !summarizerWindow ||
    textTokens(fold(priorSummary, joined)) <= summarizerWindow
  ) {
    return summarize(fold(priorSummary, joined));
  }

  // Map: summarize each window-sized chunk (message-boundary aligned).
  const chunks = packSegments(segments, summarizerWindow);
  const chunkSummaries: string[] = [];
  for (const chunk of chunks) chunkSummaries.push(await summarize(chunk));

  // Termination guard (m8): the recursion shrinks `segments`, but if the prior
  // summary ALONE exceeds the window, the folded single-pass check above can
  // never pass — chunkSummaries collapses to one segment and stays there,
  // recursing forever (unbounded paid model calls). When we can no longer make
  // progress (nothing left to reduce), fold the prior in and do one final
  // summarize; the summarizer truncates rather than us looping.
  if (chunkSummaries.length <= 1) {
    return summarize(fold(priorSummary, chunkSummaries.join("\n\n")));
  }

  // Reduce: the joined chunk summaries (+ prior) can THEMSELVES exceed the window
  // when there are many chunks, so recurse rather than summarizing them whole —
  // the reduce step must never re-overflow (ADR-0012 §Tier 1 map-reduce). Each
  // pass shrinks the segment count, so this converges.
  return summarizePrefix(
    chunkSummaries,
    priorSummary,
    summarize,
    summarizerWindow,
  );
}

/**
 * Tier 1 (durable) compaction over UIMessages. Stage 1 prunes; if that reaches
 * the target, no model call is made and the prefix stays (lighter). Otherwise
 * Stage 2 summarizes the prefix into one synthetic summary and drops it from the
 * model view. Raw messages are never mutated by the caller (ADR-0012 §View, not delete — this returns a
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

  // Reuse the caller's already-computed estimate of `messages` rather than
  // re-running the full char/4 pass on the hot path.
  const initialEstimate = opts.knownEstimate ?? estimate(messages);

  // No-op when already within target (incl. the existing summary). This is what
  // makes a follow-up turn after compaction NOT re-fire (hysteresis, ADR-0012 §Tier 1 (hysteresis)).
  // Bypassed when `force` is set — recovery sets the dirty flag AFTER a provider
  // rejection, so the estimator already proved wrong; using it as a no-op gate
  // causes an infinite overflow→dirty→no-op loop (ADR-0012 §Recovery).
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

  // Past this point we are over target. Recent (kept) messages stay in the model
  // view, so extreme outliers (e.g. large MCP tool dumps) bloat tokensAfter.
  // The hard window wall (ADR-0012 §Hard window wall): trim them ONLY when the kept view would breach
  // the hard window wall (`inputBudget`); a soft `targetTokens` miss is left at
  // full fidelity and just re-compacts next turn (cheap). The newest message is
  // always exempt — it is the data the current turn is actively about.
  const recentThreshold =
    opts.minRecentPrunableChars ?? opts.minPrunableChars * 5;
  const pruneRecentExemptNewest = (
    msgs: PlatypusUIMessage[],
  ): { messages: PlatypusUIMessage[]; changed: boolean } => {
    let changed = false;
    const messages = msgs.map((m, i) => {
      if (i === msgs.length - 1) return m; // newest always exempt
      // Include oversized text parts (e.g. large recent code answers), not just
      // tool outputs. This is the hard-wall path (the view would otherwise breach
      // inputBudget), so trimming a recent answer's view beats overflowing; the
      // raw message stays in the DB (ADR-0012 §View, not delete).
      const pruned = pruneUIMessage(m, recentThreshold, { includeText: true });
      if (pruned.changed) changed = true;
      return pruned.message;
    });
    return { messages, changed };
  };
  // Decides whether to keep `recent` verbatim or trim it (ADR-0012 §Hard window wall). Returns the
  // kept messages and their token estimate (reused for `afterEstimate` so the
  // recent set is never re-estimated). `fixedTokens` is the kept view's NON-recent
  // part (pruned prefix and/or folded summary). When `inputBudget` is omitted the
  // wall is unknown → always trim once over target (guard predating ADR-0012 §Hard window wall).
  const keepRecentWithinWall = (
    fixedTokens: number,
    recentMsgs: PlatypusUIMessage[],
  ): { messages: PlatypusUIMessage[]; recentTokens: number } => {
    const recentTokens = estimate(recentMsgs);
    if (
      opts.inputBudget !== undefined &&
      fixedTokens + recentTokens <= opts.inputBudget
    ) {
      return { messages: recentMsgs, recentTokens }; // within wall — full fidelity
    }
    const trimmed = pruneRecentExemptNewest(recentMsgs);
    // Nothing prunable (no tool outputs over threshold) → reuse the estimate.
    return {
      messages: trimmed.messages,
      recentTokens: trimmed.changed ? estimate(trimmed.messages) : recentTokens,
    };
  };

  // Warn only when the kept view still breaches the HARD wall after trimming —
  // i.e. recent genuinely couldn't be brought under the window (one oversized
  // result; ingestion-cap territory). Under ADR-0012 §Hard window wall a soft `targetTokens`
  // miss is by design (recent kept verbatim below the wall), so it is NOT a
  // warning. Falls back to the old `target * 2` heuristic when no wall is supplied.
  const warnIfOverWall = (afterEstimate: number) => {
    const over =
      opts.inputBudget !== undefined
        ? afterEstimate > opts.inputBudget
        : afterEstimate > opts.targetTokens * 2;
    if (over) {
      logger.warn(
        {
          afterEstimate,
          targetTokens: opts.targetTokens,
          inputBudget: opts.inputBudget,
          keepRecentMessages: opts.keepRecentMessages,
        },
        "compaction fired but recent messages exceed the window — a single oversized tool result may be uncompactable (see ingestion cap)",
      );
    }
  };

  // ADR-0012 §Tier 1: nothing to summarize when the prefix is empty (history fits within
  // keepRecentMessages). Also bail when the boundary message has no id — we
  // cannot anchor a watermark there, and committing a watermark:null +
  // non-null summary would orphan the summary (viewAfterWatermark ignores
  // contextSummary when the watermark is null, so the previously-summarised
  // prefix reappears every turn).
  const watermarkId =
    prefix.length > 0 ? (prefix[prefix.length - 1].id ?? null) : null;
  if (prefix.length === 0 || watermarkId === null) {
    const prunedPrefixTokens = estimate(prunedPrefix) + priorTokens;
    const keptRecent = keepRecentWithinWall(prunedPrefixTokens, recent);
    const kept = [...prunedPrefix, ...keptRecent.messages];
    const afterEstimate = prunedPrefixTokens + keptRecent.recentTokens;
    warnIfOverWall(afterEstimate);
    return {
      keptMessages: kept,
      summaryText: opts.priorSummary ?? null,
      watermarkId: null,
      messagesDropped: 0,
      usedModelCall: false,
      estimatedTokens: afterEstimate,
    };
  }

  // Stage 2 — summarize the pruned prefix into one synthetic summary.
  const summaryText = await summarizePrefix(
    renderUIMessageList(prunedPrefix),
    opts.priorSummary,
    opts.summarize,
    opts.summarizerWindow,
  );

  const summaryTokens = textTokens(summaryText);
  const keptRecent = keepRecentWithinWall(summaryTokens, recent);
  const afterEstimate = keptRecent.recentTokens + summaryTokens;
  warnIfOverWall(afterEstimate);

  return {
    keptMessages: keptRecent.messages,
    summaryText,
    watermarkId,
    messagesDropped: prefix.length,
    usedModelCall: true,
    estimatedTokens: afterEstimate,
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
    // ADR-0012 §Tier 1 (Stage 1 prune): @ai-sdk/mcp emits {type:"content"} for essentially every MCP tool
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

/** Per-message transcript strings (one entry per message). See renderUIMessageList. */
function renderModelMessageList(messages: ModelMessage[]): string[] {
  return messages.map((m) => {
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
            // ADR-0012 §Tier 1 (Stage 1 prune): extract text items from content-type MCP output.
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
  });
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
  // Force-guarded like gate 1 (ADR-0012 §Recovery): when recovery forces a trim the provider
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

  // ADR-0012 §Tier 1 (model-side): nothing to summarize when the prefix is empty (recent
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
    renderModelMessageList(prunedPrefix),
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
//   1. Reconstructs the compacted VIEW from persisted state every turn (ADR-0012 §View, not delete) —
//      drop messages up to the watermark, re-inject the stored summary.
//   2. Triggers a fresh compaction when the projected size crosses the trigger
//      ratio, OR when `compactionDirty` forces it (recovery hand-off, ADR-0012 §Recovery).
//   3. Persists any new summary/watermark + clears dirty via the single CAS
//      writer (ADR-0012 §One durable writer), the loser skipping safely on contention.
// ===========================================================================

/** Resolved per-turn compaction config (ADR-0012 §Config & kill switch), defaults applied. */
export type CompactionConfig = {
  compactionEnabled: boolean;
  triggerRatio: number;
  targetRatio: number;
  reserveRatio: number;
  keepRecentMessages: number;
  minPrunableChars: number;
  /** Threshold for pruning tool results in the kept (recent) messages after
   * Stage 2 summarization. Higher than minPrunableChars — we trim extreme
   * outliers (e.g. huge MCP tool dumps) without destroying useful context. */
  minRecentPrunableChars: number;
  /** Stage 0 context editing (ADR-0012 §Stage 0 — context editing): elide OLD bulky tool results to a
   * placeholder before the trigger check, so a leaned view can avoid summarizing
   * entirely. Gated alongside the COMPACTION_ENABLED kill switch. */
  contextEditingEnabled: boolean;
  /** Stage 0: exempt the last N tool results from elision (recency, by count). */
  keepRecentToolResults: number;
  /** Stage 0: only elide a tool result whose serialized output exceeds this. */
  minEditableToolChars: number;
};

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  compactionEnabled: true,
  triggerRatio: 0.8,
  targetRatio: 0.5,
  reserveRatio: 0.05,
  // A fixed message *count* is a poor proxy when messages vary wildly in size: a
  // few large recent answers can dominate the window while the keep-window
  // shields them from summarization, so a smaller window lets summarization reach
  // more of the bulk. Tunable via COMPACTION_KEEP_RECENT; the newest message is
  // always exempt regardless (ADR-0012 §Hard window wall).
  keepRecentMessages: 5,
  minPrunableChars: 2000,
  minRecentPrunableChars: 10000,
  contextEditingEnabled: true,
  keepRecentToolResults: 4,
  // 50k chars ≈ 12.5k tokens — matches LibreChat's minPrunableToolChars, the only
  // direct per-result char-gate analog. High enough to spare medium results (less
  // cache churn) while still catching the ~160k-char mempalace dump.
  minEditableToolChars: 50000,
};

export type Budget = {
  inputBudget: number;
  triggerTokens: number;
  targetTokens: number;
};

/**
 * Budget math (ADR-0012 §Tier 1 (budget math)): the trigger/target are fractions of the INPUT budget —
 * the window minus the output reservation and a safety headroom — not of the raw
 * window. When the resolved max output is unknown, reserve a conservative slice.
 */
export function computeBudget(
  contextWindow: number,
  maxOutputTokens: number | undefined,
  config: CompactionConfig,
): Budget {
  const rawOutputReserve =
    maxOutputTokens ?? Math.min(4096, Math.floor(contextWindow * 0.25));
  // Cap the output reservation at half the window (ADR-0012 §Tier 1 (budget math)). litellm's
  // `max_input_tokens` (which feeds `contextWindow`) is already input-scoped for
  // some providers, so subtracting a large `max_output_tokens` again can collapse
  // `inputBudget` toward 1 — making trigger/target ≈ 0 and thrashing. Capping
  // keeps the (otherwise-safe) over-reservation from degenerating.
  const maxOutputReserve = Math.min(
    rawOutputReserve,
    Math.floor(contextWindow * 0.5),
  );
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
 * First-turn safety margin on the char/4 projection (ADR-0012 §Token estimation (cold-start margin)): char/4
 * under-counts CJK, dense JSON, and tool chatter, and on a cold start there is
 * no provider-reported `usage.inputTokens` to correct it.
 */
export const COLD_START_MARGIN = 1.15;

/**
 * The Tier 1 trigger projection (ADR-0012 §Tier 1 (trigger projection)): what THIS turn is about to put on
 * the wire, not just the stored messages. `overheadTokens` carries the
 * estimated system prompt + tool schemas + skill payload — invisible to a
 * message-only estimate but sent to the model on every turn (the observed
 * live-test gap: provider reported 8888 input tokens vs ~986 message-only).
 * `lastInputTokens` is the provider-reported count from the prior turn — the
 * corrective baseline for turns ≥ 2 (threaded in the ADR-0012 §Context-usage ring usage-metadata chunk).
 * When it is absent the whole char/4 projection is inflated by
 * {@link COLD_START_MARGIN} (ADR-0012 §Token estimation (cold-start margin)).
 */
export function projectTier1Tokens(args: {
  messageTokens: number;
  priorSummaryTokens: number;
  overheadTokens?: number;
  lastInputTokens?: number;
}): number {
  const charBased =
    args.messageTokens + args.priorSummaryTokens + (args.overheadTokens ?? 0);
  // Treat a non-positive count as "no baseline" (ADR-0012 §Tier 1 (trigger projection)): some OpenAI-compatible /
  // vLLM gateways omit `usage.inputTokens`, which we persist as
  // `contextTokens = 0`. A bare `== null` check would let that 0 slip through —
  // skipping the cold-start margin AND no-op-ing the `max()` below — leaving the
  // raw char/4 projection with no safety buffer on EVERY turn for those
  // providers. Falling back to the margin keeps the conservative over-count.
  if (args.lastInputTokens == null || args.lastInputTokens <= 0) {
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
  };
}

/** Fail-loud event so the transcript shows compaction happened (ADR-0012 §Tier 1). */
export type CompactionEvent = {
  type: "context-compacted";
  messagesDropped: number;
  tokensBefore: number;
  tokensAfter: number;
};

export type Tier1Input = {
  chatId: string;
  /** Full durable history (post-`inlineFileUrls`, ADR-0012 §Token estimation). */
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
   * system prompt, tool schemas, skill list (ADR-0012 §Tier 1 (trigger projection)). Counted toward the
   * trigger and subtracted from the compaction target (compaction cannot
   * shrink it, so hysteresis must leave room for it — ADR-0012 §Tier 1 (hysteresis)).
   */
  overheadTokens?: number;
  /** Provider-reported `usage.inputTokens` from the prior turn (ADR-0012 §Tier 1 (trigger projection), via ADR-0012 §Context-usage ring). */
  lastInputTokens?: number;
  onEvent?: (event: CompactionEvent) => void;
  /**
   * Fires once, the instant Stage 2's first model summarize call begins
   * (ADR-0012 §Compaction trace in the timeline — live In-Progress). Carries the
   * before-stats so the runner can write the in-progress chunk's Input. NOT
   * fired on the prune-only / no-op path — which is exactly when no trace is
   * produced, so the spinner appears iff a trace will follow. Map-reduce calls
   * summarize N times; this dedupes to one fire.
   */
  onSummarizeStart?: (before: {
    tokensBefore: number;
    messagesBefore: number;
  }) => void;
};

export type CompactionTrace = {
  /** Number of messages that were folded into the summary. */
  messagesDropped: number;
  /** First ~120 chars of the LLM-generated summary. */
  summaryExcerpt?: string;
  /** Char/4 estimate of the pre-compaction view (basis: messages + prior summary + overhead). */
  tokensBefore: number;
  /** Char/4 estimate of the post-compaction view (same basis). */
  tokensAfter: number;
  /** Message count of the compacted view before this run (post-watermark, edited view — same basis as tokensBefore). */
  messagesBefore: number;
};

/**
 * The two chunk payloads for the `compact_context` trace, so the live stream
 * writer (agent-runner, ADR-0012 §Compaction trace in the timeline) and the
 * standalone persisted-message builder ({@link buildCompactionTraceMessage},
 * ADR-0012 §Force-compact on demand) render identically. Input carries the
 * "before" stats (shown during the Running phase); Output carries the "after"
 * stats + reduction + summary excerpt (shown when Completed).
 */
export function compactionTracePayloads(trace: CompactionTrace): {
  input: Record<string, unknown>;
  output: Record<string, unknown>;
} {
  const tokensSaved = Math.max(0, trace.tokensBefore - trace.tokensAfter);
  const reductionPct =
    trace.tokensBefore > 0
      ? Math.round((tokensSaved / trace.tokensBefore) * 100)
      : 0;
  return {
    input: {
      tokensBefore: trace.tokensBefore,
      messagesBefore: trace.messagesBefore,
    },
    output: {
      tokensAfter: trace.tokensAfter,
      tokensSaved,
      reductionPct,
      messagesDropped: trace.messagesDropped,
      ...(trace.summaryExcerpt ? { summaryExcerpt: trace.summaryExcerpt } : {}),
    },
  };
}

/** Tool name for the synthetic compaction-trace tool-call/result pair (ADR-0012 §Compaction trace in the timeline).
 * Shared by the stream-trace producer (agent-runner), the strip filter that
 * keeps it out of the model payload, the ADR-0012 §Force-compact on demand persisted-message builder, and the
 * frontend display-name mapping. */
export const COMPACT_CONTEXT_TOOL_NAME = "compact_context";

/** Builds a standalone synthetic assistant message carrying the compaction
 * trace as a `compact_context` tool-call/result pair (ADR-0012 §Force-compact on demand — forced compaction
 * has no live stream to inject into, so the trace is persisted as its own
 * message instead). The message is always appended ABOVE the watermark, so it
 * is never itself summarized; the strip filter keeps it out of the model
 * payload on subsequent turns. */
export function buildCompactionTraceMessage(
  trace: CompactionTrace,
  id: string,
): PlatypusUIMessage {
  const { input, output } = compactionTracePayloads(trace);
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: `tool-${COMPACT_CONTEXT_TOOL_NAME}`,
        toolCallId: `${id}-call`,
        state: "output-available",
        input,
        output,
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
   * "compaction happened" signal (ADR-0012 §Compaction trace in the timeline). Deliberately undefined for
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
    // distrust the summary and fall back to the full history (defensive ADR-0012 §Summary invalidation).
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

  // Stage 0 — context editing (ADR-0012 §Stage 0 — context editing): elide OLD bulky tool results to
  // placeholders BEFORE the trigger projection, so a leaned view can drop under
  // the trigger and skip summarization entirely. Pure/deterministic, no durable
  // state (ADR-0012 §View, not delete). Gated by the COMPACTION_ENABLED kill switch (recovery stays the
  // net, ADR-0012 §Recovery is the net) AND the per-feature `contextEditingEnabled`. Returns the same array
  // reference when nothing qualified, so the no-op case re-estimates nothing.
  // NB (ADR-0012 §Stage 0 — context editing): the elided placeholders also flow into the prefix that
  // Stage 2 would summarize, so a summarized result keeps only its placeholder —
  // an accepted fidelity trade-off (a 40k dump's head+tail is poor summary fodder
  // and the raw stays in the DB).
  const contextEditing =
    config.compactionEnabled && config.contextEditingEnabled
      ? editToolResults(afterWatermark, {
          keepRecentToolResults: config.keepRecentToolResults,
          minEditableToolChars: config.minEditableToolChars,
        })
      : { messages: afterWatermark, resultsElided: 0, charsReclaimed: 0 };
  const editedView = contextEditing.messages;
  if (contextEditing.resultsElided > 0) {
    logger.info(
      {
        metric: "context_edited",
        chatId: input.chatId,
        resultsElided: contextEditing.resultsElided,
        charsReclaimed: contextEditing.charsReclaimed,
      },
      "context_edited",
    );
  }

  const inject = (summary: string | null, msgs: PlatypusUIMessage[]) =>
    summary ? [summaryUIMessage(summary), ...msgs] : msgs;

  // The view that would be sent if we did nothing more this turn.
  const baseView = inject(priorSummary, editedView);
  const overheadTokens = input.overheadTokens ?? 0;
  // Compute the char/4 pass over the unsummarized view once and reuse it
  // for both the trigger projection and compactUIMessages' no-op gate.
  const messageTokens = estimate(editedView);
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

  // `projected` mixes in the provider's `lastInputTokens` floor (and the
  // cold-start margin), but `compactUIMessages`' no-op gate re-checks char/4
  // alone. When the trigger fired only because that floor exceeded the char
  // basis, the char-only gate would wrongly no-op — trigger true, 0 dropped,
  // every turn — until real overflow hits recovery (M1). Force past the gate so
  // the ADR promise "compact when projected >= trigger" is actually met. Char/4
  // chronically under-counts here, so we cannot trust a prune-only early return
  // either; forcing summarize is the honest response to the provider floor.
  const charOnlyBasis = messageTokens + priorSummaryTokens + overheadTokens;
  const projectionFloorTriggered =
    triggered && !forceCompact && projected > charOnlyBasis;

  logger.info(
    {
      metric: "compaction.check",
      chatId: input.chatId,
      compactionEnabled: config.compactionEnabled,
      projected,
      triggerTokens: budget.triggerTokens,
      targetTokens: budget.targetTokens,
      inputBudget: budget.inputBudget,
      triggered,
      forceCompact,
      messageTokens,
      priorSummaryTokens,
      overheadTokens: input.overheadTokens ?? 0,
      lastInputTokens: input.lastInputTokens,
    },
    "compaction.check",
  );

  if (!triggered) {
    return { messages: baseView, compacted: false };
  }

  // Compaction can only shrink the messages, never the per-turn overhead, so
  // the target the messages must fit in is reduced by it (ADR-0012 §Tier 1 (hysteresis)). When the
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

  // The hard wall the kept view must fit under (ADR-0012 §Hard window wall), net of the per-turn
  // overhead compaction cannot shrink — mirrors how effectiveTarget adjusts the
  // soft target. Recent tool results are trimmed only when this is breached.
  const effectiveInputBudget = Math.max(0, budget.inputBudget - overheadTokens);

  // One-shot wrap of the summarizer: fire onSummarizeStart the instant Stage 2's
  // first model call begins (ADR-0012 §Compaction trace in the timeline). This is
  // the point where the before-stats are in scope (charOnlyBasis / editedView),
  // and it fires ONLY on the summarize path — never on the prune-only early
  // return — so the live in-progress spinner appears iff a trace will follow.
  // Map-reduce invokes summarize repeatedly; the guard dedupes to one fire.
  let summarizeStartFired = false;
  const summarize: Summarize = async (text) => {
    if (!summarizeStartFired) {
      summarizeStartFired = true;
      input.onSummarizeStart?.({
        tokensBefore: charOnlyBasis,
        messagesBefore: editedView.length,
      });
    }
    return input.summarize(text);
  };

  const result = await compactUIMessages(editedView, {
    targetTokens: effectiveTarget,
    inputBudget: effectiveInputBudget,
    keepRecentMessages: config.keepRecentMessages,
    minPrunableChars: config.minPrunableChars,
    minRecentPrunableChars: config.minRecentPrunableChars,
    imageProvider,
    priorSummary,
    summarize,
    summarizerWindow: input.summarizerWindow,
    // When dirty-forced the estimator already proved wrong (ADR-0012 §Recovery): bypass the
    // no-op gate so recovery's dirty flag actually shrinks the history. Also
    // bypass when the trigger fired via the provider-token floor (M1) — the
    // char-only gate would otherwise no-op despite the projection being over.
    force: forceCompact || projectionFloorTriggered,
    // The no-op gate estimates this exact set; reuse the value above.
    knownEstimate: messageTokens,
  });

  const view = inject(result.summaryText ?? priorSummary, result.keptMessages);

  // Persist through the single CAS writer (ADR-0012 §One durable writer). The decision is gated on the
  // version we read; if a concurrent writer advanced it, we skip rather than
  // recompute (the wasted summarize is bounded, never corrupting). The
  // version-pinning gate is shared so both write paths decide identically.
  const capturedVersion = state.version;
  // On a version mismatch we skip as "covered" WITHOUT clearing dirty (ADR-0012
  // §One durable writer). Clearing on skip is only safe when the winner actually
  // compacted; a concurrent invalidateCompaction also advances the version yet
  // leaves dirty set on purpose (it resets the summary, it does not shrink
  // history) — clearing dirty here would then drop the forced compaction the
  // overflow demanded. Leaving dirty set is strictly safe: worst case is one
  // extra compaction next turn.
  const pinnedWrite = (patch: WatermarkPatch) =>
    commitWatermark(input.store, input.chatId, (latest) =>
      latest.version === capturedVersion
        ? { kind: "write", patch }
        : { kind: "skip", reason: "covered" },
    );
  let commit: CommitResult | undefined;

  if (result.usedModelCall) {
    // Same-basis before/after for the user-visible reduction: both are
    // char/4 message estimates plus the per-turn overhead. The trigger
    // `projected` mixes in the provider's `lastInputTokens` floor and is NOT
    // comparable to the message-only post estimate, so reporting it as "before"
    // overstated the drop. Computed only on the model-call path (the only place
    // these are reported).
    const tokensBefore = messageTokens + priorSummaryTokens + overheadTokens;
    const tokensAfter = result.estimatedTokens + overheadTokens;

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
        tokensBefore,
        tokensAfter,
        // Keep the raw trigger projection for correlation with compaction.check.
        projected,
        messagesDropped: result.messagesDropped,
      },
      "compaction.fired",
    );
    input.onEvent?.({
      type: "context-compacted",
      messagesDropped: result.messagesDropped,
      tokensBefore,
      tokensAfter,
    });
  } else if (state.compactionDirty) {
    // Forced by recovery but pruning/within-target sufficed: just clear the flag.
    commit = await pinnedWrite({ dirty: false });
  }

  // Only surface a trace when an actual model summary was produced AND it
  // durably landed. Prune-only and force-dirty-within-target runs drop 0
  // messages with no excerpt — a trace there would be an empty, confusing
  // timeline entry (ADR-0012 §Compaction trace in the timeline). Gating on the
  // committed write also prevents a phantom trace when a concurrent writer
  // advanced the version and the summary was skipped (m5): the summary was NOT
  // persisted, so a "compacted" timeline entry would be a lie.
  const compactionTrace: CompactionTrace | undefined =
    result.usedModelCall && result.summaryText && commit?.status === "applied"
      ? {
          messagesDropped: result.messagesDropped,
          summaryExcerpt: result.summaryText.slice(0, 120),
          tokensBefore: charOnlyBasis,
          tokensAfter: result.estimatedTokens + overheadTokens,
          messagesBefore: editedView.length,
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
 * submitted history changed or dropped — the ADR-0012 §Summary invalidation trigger. Because the client
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
 * Persists `compactionDirty = true` after a context-overflow recovery (ADR-0012 §Recovery).
 * Recovery never writes summary/watermark — it only flags; the next
 * `prepareChatTurn` sees the flag, forces Tier 1, and clears it inside the same
 * CAS write that advances the watermark. Goes through the single writer (ADR-0012 §One durable writer);
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

// --- Tier 2 in-turn compaction (ADR-0012 §Tier 2) ---

/**
 * Per-turn Tier 2 compaction context (ADR-0012 §Tier 2). Null when the ADR-0012 §Config & kill switch or
 * agent config disables proactive compaction. Sub-agents also receive Tier 2
 * (ADR-0012 §Sub-agents / §Tier 2 — they have no durable history for Tier 1, but their tool loop
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
 * Builds the Tier 2 in-turn compaction `prepareStep` callback (ADR-0012 §Tier 2). Fires
 * before each step of a tool loop when the accumulated model messages exceed
 * `triggerTokens` — compacts via `compactModelMessages` and returns the
 * trimmed messages. Returns `undefined` when below the threshold so the SDK
 * proceeds unchanged (ADR-0012 §Sub-agents / §Tier 2: no per-step overhead when the loop is small).
 */
export function buildTier2PrepareStep(ctx: Tier2Context): PrepareStepFunction {
  return async ({ messages }) => {
    const estimate = estimateTokens(
      modelMessagesToCountUnits(messages, ctx.imageProvider),
    );
    if (estimate < ctx.triggerTokens) return undefined;

    // Stage 2 summarize is a real network call and can throw (429/timeout) while
    // still below true overflow. A throw here would reject the SDK step and kill
    // an otherwise-successful turn. Degrade gracefully: log, proceed uncompacted;
    // the recovery middleware remains the backstop for real overflow (M3).
    let result;
    try {
      result = await compactModelMessages(messages, {
        targetTokens: ctx.targetTokens,
        keepRecentMessages: ctx.keepRecentMessages,
        minPrunableChars: ctx.minPrunableChars,
        imageProvider: ctx.imageProvider,
        summarize: ctx.summarize,
        summarizerWindow: ctx.summarizerWindow,
        // Reuse the trigger-check estimate; skips a redundant full pass.
        knownEstimate: estimate,
      });
    } catch (err) {
      logger.warn(
        { err, estimatedTokens: estimate },
        "Tier 2 in-turn compaction failed; proceeding uncompacted",
      );
      return undefined;
    }

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
