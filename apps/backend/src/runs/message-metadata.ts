import type { TextStreamPart, ToolSet } from "ai";
import {
  isTruncatedByTokenLimit,
  stoppedAtStepCeiling,
} from "./stream-error.ts";
import type { ChatMessageMetadata } from "../types.ts";

/**
 * Builds the `messageMetadata` extractor `toUIMessageStream` calls for every
 * stream part.
 *
 * It is the only seam for saying anything about a stream that has already been
 * flushed to the client. The SDK deep-merges what it returns into the message,
 * so each part contributes only the key it owns and a later part leaves the
 * earlier ones standing. Returning the whole object every time would work too,
 * but only because the merge happens to skip `undefined` values.
 *
 * Extracted from the runner so the Context occupancy reading can be driven
 * through a real multi-step stream in a test — the run-lifecycle suite mocks
 * the SDK wholesale, so the usage numbers there are whatever a test author
 * typed and an implementation reading the cumulative sum passes it happily.
 *
 * `agentId` is read once, here, rather than off the run state when the `start`
 * part arrives: the turn resolves during setup, before the stream is built, and
 * nothing reassigns the resolved agent mid-run.
 *
 * `toolDurations` is the live map the runner fills from `onToolExecutionEnd`.
 * It is read rather than copied: this extractor runs per part, and each read
 * happens after the entry it wants has been written.
 *
 * `searchUnavailable` is a setup-time fact like `agentId` — Turn resolution
 * decided it before the stream existed — and rides `start` for a second reason
 * besides: an aborted run never emits a `finish` part, and a turn cancelled
 * halfway should still say it ran without the search it was promised.
 *
 * The setup-time facts arrive as one object rather than as positional
 * arguments: `agentId` and `searchUnavailable` travel together at every hop
 * from Turn resolution to here, and the next such fact should not have to
 * become a fourth position that call sites read as a bare `true`.
 *
 * `prepDurationMs` and `driveStartMs` are the same kind of setup-time fact,
 * for the two-phase wall clock issue #354 adds: Turn resolution has already
 * finished by the time this extractor exists, so its duration rides `start`
 * exactly like `agentId`; the Drive's own duration cannot ride `start` because
 * it has not happened yet, so only the moment it began does, and each
 * `finish-step` computes the elapsed time from it.
 */
export type MessageMetadataFacts = {
  /** The resolved Agent id, absent on a turn that resolved no Agent. */
  agentId?: string;
  /** The live map the runner fills from `onToolExecutionEnd`. */
  toolDurations?: ReadonlyMap<string, number>;
  /** Turn resolution served no search tools for a turn that asked for search. */
  searchUnavailable?: boolean;
  /**
   * The turn's resolved **Step ceiling** — the same figure the loop's step-count
   * stop condition is built from. Needed here because the terminal finish reason
   * alone cannot say whether the loop was stopped or the model was done.
   *
   * Optional like every fact above it, so this factory keeps its no-argument
   * form: a caller that leaves it out gets no step-ceiling reporting rather than
   * a comparison against a guessed ceiling. Every production caller passes it —
   * the drive reads it off the plan it is about to invoke.
   */
  stepCeiling?: number;
  /** How long Turn resolution took, in whole milliseconds. Absent for a drive
   *  (e.g. a delegated sub-Agent) that never measured one. */
  prepDurationMs?: number;
  /** When the model request was sent, on the same clock as `now`. `modelDurationMs`
   *  is the elapsed time from here, recomputed on every `finish-step`. */
  driveStartMs?: number;
  /** Injectable clock, so a test can assert an exact `modelDurationMs` rather
   *  than a real elapsed delay. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Whether a tool name is clearable this turn — the core allowlist plus
   * whatever the Tool session resolved from MCP `readOnlyHint` declarations
   * (ADR-0021, issue #626). Read on `tool-result`/`tool-error`, the same
   * parts `toolDurations` is read on, since both need the call that just
   * finished. Absent means no tool is ever reported, which is what a run with
   * no resolved Tool session (a headless Trigger) already gets today.
   */
  isClearableTool?: (toolName: string) => boolean;
};

export const createMessageMetadata = ({
  agentId,
  toolDurations = new Map(),
  searchUnavailable = false,
  stepCeiling,
  prepDurationMs,
  driveStartMs,
  now = Date.now,
  isClearableTool,
}: MessageMetadataFacts = {}) => {
  // Whether any step of this turn has reported an input-token count. Only
  // read to erase a reading, never to synthesise one — see the `finish-step`
  // branch below.
  let occupancyReported = false;
  // How many model calls the turn has completed. Counted from the per-step
  // finish parts this extractor already sees: the terminal finish carries no
  // step count of its own, and the run's own tally is not in scope here.
  let steps = 0;
  // The running Token usage sum (issue #354) — folded across every step that
  // reported one, as opposed to `contextOccupancy`'s last-value replacement
  // right beside it.
  let inputTokensSum = 0;
  let outputTokensSum = 0;
  // The turn's clearable Tool names among the ones it has actually called so
  // far — reported in full each time, like `tokenUsage`'s sum, since the
  // merge replaces an array rather than concatenating it.
  const calledClearableToolNames = new Set<string>();

  return ({
    part,
  }: {
    part: TextStreamPart<ToolSet>;
  }): ChatMessageMetadata | undefined => {
    if (part.type === "start") {
      const meta: ChatMessageMetadata = {};
      if (agentId) meta.agentId = agentId;
      if (searchUnavailable) meta.searchUnavailable = true;
      if (typeof prepDurationMs === "number") {
        meta.prepDurationMs = Math.round(prepDurationMs);
      }
      return Object.keys(meta).length > 0 ? meta : undefined;
    }
    // Context occupancy (ADR-0018), Token usage and the Drive's elapsed time
    // (issue #354) — all three are emitted per step rather than once at the
    // end: the terminal `finish` part is never sent on an aborted run, and
    // cancelling a long turn is exactly when the context had grown most.
    //
    // `part.usage` here is one call's usage, so occupancy reads it directly
    // while Token usage folds it onto the running sum below — the same trap
    // ADR-0018 already documents for occupancy applies again here if the two
    // are ever confused: on a twenty-step turn the sum reads roughly an order
    // of magnitude higher than any single step's count.
    if (part.type === "finish-step") {
      steps += 1;
      const meta: ChatMessageMetadata = {};
      const { inputTokens, outputTokens } = part.usage;

      if (typeof inputTokens !== "number") {
        // This step's context size is unknown, so any figure already on the
        // message is a smaller, older call's — stale, and about to be read as
        // this turn's. Erase it with a concrete `null`, which the merge does
        // apply, rather than returning nothing and letting it stand. Until
        // some step has reported a count there is nothing to erase, and the
        // key stays absent so a Provider that reports no usage at all records
        // no occupancy whatsoever.
        if (occupancyReported) meta.contextOccupancy = null;
      } else {
        occupancyReported = true;
        meta.contextOccupancy = {
          inputTokens,
          // Concrete, never omitted, for the same reason: the merge skips
          // `undefined`, so leaving the key out would pair a fresh input count
          // with a previous step's output count.
          outputTokens: typeof outputTokens === "number" ? outputTokens : null,
        };
      }

      // Never needs erasing, unlike occupancy: each step's usage only adds to
      // the sum, so a step that reports nothing cannot make an earlier step's
      // sum stale. Guarded the same way occupancy's absence is — until some
      // step reports a number, the key stays absent rather than writing a
      // `{ 0, 0 }` sum for a turn whose Provider never reported anything.
      if (typeof inputTokens === "number" || typeof outputTokens === "number") {
        inputTokensSum += inputTokens ?? 0;
        outputTokensSum += outputTokens ?? 0;
        meta.tokenUsage = {
          inputTokens: inputTokensSum,
          outputTokens: outputTokensSum,
        };
      }

      if (typeof driveStartMs === "number") {
        meta.modelDurationMs = Math.round(now() - driveStartMs);
      }

      return Object.keys(meta).length > 0 ? meta : undefined;
    }
    // How long the tool that just finished took. This is the ONLY way the
    // figure reaches the browser: the stream's tool reducer rebuilds the tool
    // part from the stored invocation and discards the `toolMetadata` an output
    // chunk carried, so the per-part stamp `applyToolDurations` writes is
    // invisible until the message is re-fetched (issue #353).
    //
    // Read on the tool's own result part rather than gathered at the end, so
    // each duration lands with the output it describes instead of the whole set
    // arriving after the reply. The SDK awaits `onToolExecutionEnd` inside
    // `executeToolCall` and only emits the result afterwards, so the map
    // already holds this call's figure — ordering, not luck.
    //
    // One key per call, merged: the SDK's deep merge recurses into plain
    // objects, so each part contributes its own entry and the accumulated map
    // survives. A call absent from the map was executed by the Provider, never
    // locally, and so was never measured.
    if (part.type === "tool-result" || part.type === "tool-error") {
      const meta: ChatMessageMetadata = {};
      const durationMs = toolDurations.get(part.toolCallId);
      if (durationMs !== undefined) {
        meta.toolDurations = { [part.toolCallId]: Math.round(durationMs) };
      }
      if (isClearableTool?.(part.toolName)) {
        calledClearableToolNames.add(part.toolName);
        meta.readOnlyToolNames = [...calledClearableToolNames];
      }
      return Object.keys(meta).length > 0 ? meta : undefined;
    }
    // The terminal finish only. A step inside a tool loop can end at the
    // ceiling and the run still recover and complete normally; flagging those
    // marks answers that were never cut short.
    if (part.type === "finish") {
      if (isTruncatedByTokenLimit(part.finishReason)) {
        return { truncatedByTokenLimit: true };
      }
      // `part.finishReason` here is a plain string, not the `{ unified, raw }`
      // object the provider-level chunk carries: this reads the stream part.
      //
      // Deciding that a tripped no-progress detector owns the stop instead is
      // the drive's, not this extractor's — it happens in the teardown, where
      // the detector is. Nothing reads this key on a run that carries one: only
      // unattended runs do, a delegated run's messages are never persisted, and
      // the card reads the guarded outcome. Wiring a detector onto an attended
      // path would be the change that makes this worth revisiting.
      if (
        stoppedAtStepCeiling({
          finishReason: part.finishReason,
          steps,
          stepCeiling,
        })
      ) {
        return { stoppedAtStepLimit: true };
      }
    }
    return undefined;
  };
};
