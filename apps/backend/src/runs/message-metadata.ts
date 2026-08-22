import type { TextStreamPart, ToolSet } from "ai";
import { isTruncatedByTokenLimit } from "./stream-error.ts";
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
 */
export type MessageMetadataFacts = {
  /** The resolved Agent id, absent on a turn that resolved no Agent. */
  agentId?: string;
  /** The live map the runner fills from `onToolExecutionEnd`. */
  toolDurations?: ReadonlyMap<string, number>;
  /** Turn resolution served no search tools for a turn that asked for search. */
  searchUnavailable?: boolean;
};

export const createMessageMetadata = ({
  agentId,
  toolDurations = new Map(),
  searchUnavailable = false,
}: MessageMetadataFacts = {}) => {
  // Whether any step of this turn has reported an input-token count. Only
  // read to erase a reading, never to synthesise one — see the `finish-step`
  // branch below.
  let occupancyReported = false;

  return ({
    part,
  }: {
    part: TextStreamPart<ToolSet>;
  }): ChatMessageMetadata | undefined => {
    if (part.type === "start") {
      const meta: ChatMessageMetadata = {};
      if (agentId) meta.agentId = agentId;
      if (searchUnavailable) meta.searchUnavailable = true;
      return Object.keys(meta).length > 0 ? meta : undefined;
    }
    // Context occupancy (ADR-0018), emitted per step rather than once at the
    // end: the terminal `finish` part is never sent on an aborted run, and
    // cancelling a long turn is exactly when the context had grown most. The
    // merge leaves the last step's figures standing.
    //
    // `part.usage` here is one call's usage. The terminal finish's
    // `totalUsage` and the run's accumulated stats both fold input tokens
    // across every step, so on a twenty-step turn they read roughly an order
    // of magnitude high. Correct as billing figures, wrong as occupancy.
    if (part.type === "finish-step") {
      const { inputTokens, outputTokens } = part.usage;
      if (typeof inputTokens !== "number") {
        // This step's context size is unknown, so any figure already on the
        // message is a smaller, older call's — stale, and about to be read as
        // this turn's. Erase it with a concrete `null`, which the merge does
        // apply, rather than returning nothing and letting it stand. Until
        // some step has reported a count there is nothing to erase, and the
        // key stays absent so a Provider that reports no usage at all records
        // no occupancy whatsoever.
        return occupancyReported ? { contextOccupancy: null } : undefined;
      }
      occupancyReported = true;
      return {
        contextOccupancy: {
          inputTokens,
          // Concrete, never omitted, for the same reason: the merge skips
          // `undefined`, so leaving the key out would pair a fresh input count
          // with a previous step's output count.
          outputTokens: typeof outputTokens === "number" ? outputTokens : null,
        },
      };
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
      const durationMs = toolDurations.get(part.toolCallId);
      return durationMs === undefined
        ? undefined
        : { toolDurations: { [part.toolCallId]: Math.round(durationMs) } };
    }
    // The terminal finish only. A step inside a tool loop can end at the
    // ceiling and the run still recover and complete normally; flagging those
    // marks answers that were never cut short.
    if (part.type === "finish" && isTruncatedByTokenLimit(part.finishReason)) {
      return { truncatedByTokenLimit: true };
    }
    return undefined;
  };
};
