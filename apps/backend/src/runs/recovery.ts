/**
 * Context-overflow recovery (ADR-0012 §Recovery).
 *
 * Recovery is the NET, proactive compaction is the plan: even when Tier 1/2 are
 * disabled (kill switch — ADR-0012 §Config & kill switch) or their estimates were wrong, a provider 400/413
 * "context too long" must not hard-fail the turn. The middleware here wraps the
 * language model so EVERY individual model call — the first call of a turn and
 * every later step of a tool loop, in both the stream and generate paths — gets
 * one trim-and-retry:
 *
 *   1. Detect the overflow ({@link isContextOverflowError}, per-provider body
 *      matrix — ADR-0012 §Recovery).
 *   2. Persist `compactionDirty = true` through the single CAS writer so the
 *      NEXT `prepareChatTurn` forces a durable Tier 1 compaction (ADR-0012
 *      §Recovery — recovery never writes summary/watermark itself; it only flags).
 *   3. Trim in-memory via {@link compactModelMessages} — the shared Tier 2
 *      adapter, NOT a bespoke trim (ADR-0012 §Recovery) — and retry the call once.
 *   4. A second failure propagates; {@link formatStreamError} in agent-runner
 *      surfaces the "conversation too large" message. No infinite retry.
 *
 * The middleware operates on the `LanguageModelV3Prompt`. Its message shape is
 * a structural subset of `ModelMessage` for everything compaction touches
 * (roles, text / tool-call / tool-result / file parts, output wrappers), so the
 * prompt is passed to `compactModelMessages` directly rather than through a
 * lossy converter — one estimator, one trimmer (ADR-0012 §One estimator /
 * §Recovery). The leading system message(s) are split off first and re-attached
 * verbatim (ADR-0012 §Tier 1: pin the system prompt; the summary must never
 * swallow it).
 */

import {
  APICallError,
  type LanguageModelMiddleware,
  type ModelMessage,
} from "ai";
import { logger } from "../logger.ts";
import { compactModelMessages, type Summarize } from "./compaction.ts";
import type { ImageProvider } from "./token-estimate.ts";

/**
 * Everything the middleware needs to trim and retry, resolved once per turn by
 * `prepareChatTurn`. `markDirty` is absent for headless runs (triggers,
 * sub-agents) — they have no durable chat row to flag.
 */
export type RecoveryContext = {
  /** Chat id, for log correlation only. Absent on headless runs. */
  chatId?: string;
  imageProvider: ImageProvider;
  /** Trim down to this many tokens (the Tier 1 hysteresis target). */
  targetTokens: number;
  /** The configured keep-recent; recovery halves it (aggressive trim, ADR-0012 §Recovery). */
  keepRecentMessages: number;
  minPrunableChars: number;
  summarize: Summarize;
  summarizerWindow?: number;
  /**
   * Persists `compactionDirty = true` (via the single CAS writer). Called as
   * soon as an overflow is DETECTED — before the retry — so the next turn
   * compacts durably even if this retry fails. Best-effort: a failure here
   * never blocks the retry.
   */
  markDirty?: () => Promise<unknown>;
};

/**
 * Per-provider context-overflow phrasings (ADR-0012 §Recovery). Matched against the
 * error message AND raw response body, case-insensitive:
 *  - OpenAI / vLLM / OpenAI-compatible: "This model's maximum context length is
 *    N tokens…" + code "context_length_exceeded"
 *  - Anthropic: "prompt is too long: N tokens > N maximum"
 *  - Google: "The input token count (N) exceeds the maximum number of tokens
 *    allowed (N)"
 *  - Bedrock: "Input is too long for requested model." (ValidationException)
 *  - Generic gateways: "too many tokens", "exceed context limit"
 */
const CONTEXT_OVERFLOW_PATTERN =
  /context[ _]length|context_length_exceeded|context window|prompt is too long|(?:maximum|max)(?:imum)? prompt length|too many tokens|maximum context|request_too_large|exceeds the (?:maximum|max)(?: number of)? (?:input )?tokens|input is too long|exceeds? (?:the )?context limit/i;

/**
 * True when `error` is a provider context-overflow rejection: an `APICallError`
 * with status 400 or 413 whose message/body matches a known overflow phrasing.
 * Rate limits (429), auth (401/403), and 5xx are deliberately excluded — those
 * have their own handling and a trim-retry would not help.
 */
export function isContextOverflowError(error: unknown): boolean {
  if (!APICallError.isInstance(error)) return false;
  if (error.statusCode !== 400 && error.statusCode !== 413) return false;
  const haystack = `${error.message ?? ""}\n${
    typeof error.responseBody === "string" ? error.responseBody : ""
  }`;
  return CONTEXT_OVERFLOW_PATTERN.test(haystack);
}

/** A V3 prompt message — structurally compatible with ModelMessage (see header). */
type PromptMessage = { role: string; content: unknown };

/**
 * Trims an overflowing prompt via the shared Tier 2 adapter. The system head
 * (leading `role:"system"` messages) is pinned and re-attached verbatim.
 * Exported for unit testing.
 */
export async function trimOverflowingPrompt<T extends PromptMessage>(
  prompt: T[],
  ctx: RecoveryContext,
): Promise<{ prompt: T[]; messagesDropped: number }> {
  let systemEnd = 0;
  while (systemEnd < prompt.length && prompt[systemEnd].role === "system") {
    systemEnd++;
  }
  const systemHead = prompt.slice(0, systemEnd);
  const rest = prompt.slice(systemEnd) as unknown as ModelMessage[];

  const result = await compactModelMessages(rest, {
    // Aggressive: halve the configured keep-recent (ADR-0012 §Recovery), floor of 2 so a
    // user/assistant pair survives.
    keepRecentMessages: Math.max(2, Math.ceil(ctx.keepRecentMessages / 2)),
    targetTokens: ctx.targetTokens,
    minPrunableChars: ctx.minPrunableChars,
    imageProvider: ctx.imageProvider,
    summarize: ctx.summarize,
    summarizerWindow: ctx.summarizerWindow,
    // The provider already rejected this prompt, so the estimator is wrong;
    // bypass the no-op gate or the retry will be byte-identical (ADR-0012 §Recovery).
    force: true,
  });

  return {
    prompt: [...systemHead, ...(result.messages as unknown as T[])],
    messagesDropped: result.messagesDropped,
  };
}

/**
 * Wraps both `doGenerate` and `doStream` with the detect → flag → trim → retry-
 * once sequence. Apply via `wrapLanguageModel({ model, middleware })` in
 * agent-runner. Note a stream that overflows MID-stream (after chunks started
 * flowing) is not recoverable — providers reject oversized prompts up front, so
 * the rejection surfaces from the `doStream()` promise itself, which is caught.
 */
export function contextOverflowRecoveryMiddleware(
  ctx: RecoveryContext,
): LanguageModelMiddleware {
  // Shared by both wrappers: returns the retried params, or rethrows.
  const recoverParams = async <P extends { prompt: PromptMessage[] }>(
    error: unknown,
    params: P,
  ): Promise<P> => {
    if (!isContextOverflowError(error)) throw error;

    logger.warn(
      {
        metric: "recovery.overflow_detected",
        chatId: ctx.chatId,
        error: String(error),
      },
      "context overflow detected; trimming and retrying once",
    );

    // Flag durable compaction for the NEXT turn first (ADR-0012 §Recovery) — even if the
    // retry below fails, the next prepareChatTurn must force Tier 1.
    if (ctx.markDirty) {
      try {
        await ctx.markDirty();
      } catch (err) {
        logger.error(
          { err, chatId: ctx.chatId },
          "failed to persist compactionDirty after overflow",
        );
      }
    }

    try {
      const { prompt, messagesDropped } = await trimOverflowingPrompt(
        params.prompt,
        ctx,
      );
      // Nothing could be trimmed (e.g. ≤2 non-system messages) — the retry would
      // be byte-identical and re-fail. Surface the original overflow instead of
      // burning a guaranteed-failing call (m1).
      if (messagesDropped === 0) {
        logger.warn(
          { metric: "recovery.no_progress", chatId: ctx.chatId },
          "overflow recovery trimmed nothing; surfacing original overflow",
        );
        throw error;
      }
      logger.info(
        { metric: "recovery.retry", chatId: ctx.chatId, messagesDropped },
        "overflow recovery trim complete; retrying model call",
      );
      return { ...params, prompt };
    } catch (trimError) {
      // The trim itself failed (e.g. the summarize call errored). Surface the
      // ORIGINAL overflow so the user sees the actionable message.
      logger.error(
        { err: trimError, chatId: ctx.chatId },
        "overflow recovery trim failed",
      );
      throw error;
    }
  };

  // Runs the single retry and logs recovery.failed if the provider rejects the
  // trimmed prompt too (the dead end formatStreamError then surfaces to the user).
  const retry = async <R>(op: () => PromiseLike<R>): Promise<R> => {
    try {
      return await op();
    } catch (retryError) {
      logger.error(
        {
          metric: "recovery.failed",
          chatId: ctx.chatId,
          error: String(retryError),
        },
        "overflow recovery retry still rejected by provider",
      );
      throw retryError;
    }
  };

  return {
    specificationVersion: "v3",
    wrapGenerate: async ({ doGenerate, params, model }) => {
      try {
        return await doGenerate();
      } catch (error) {
        const next = await recoverParams(error, params);
        return retry(() => model.doGenerate(next));
      }
    },
    wrapStream: async ({ doStream, params, model }) => {
      try {
        return await doStream();
      } catch (error) {
        const next = await recoverParams(error, params);
        return retry(() => model.doStream(next));
      }
    },
  };
}
