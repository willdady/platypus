import { z } from "zod";

/**
 * A **Transcript summary** (GLOSSARY.md, ADR-0041): a durable condensation of a
 * Chat's older Transcript that model calls receive in place of the messages it
 * covers. Rows are never updated; a new row supersedes — never rewrites — an
 * older one.
 *
 * The shape the API returns. The row's full record (covered ids, stats) is
 * what makes each summary self-describing: whether a summary is usable on the
 * current Active path is a pure read-time check against what it covered, and
 * `stats` records from day one what a later per-summary cost display needs.
 *
 * Absent here deliberately: the summary is never a `chat_message`. It renders
 * as a divider between the coverage and the kept tail, and its `stats` are not
 * surfaced in the product in v1 (ADR-0041, "Deferred").
 */
export type TranscriptSummary = {
  id: string;
  /** The Chat the summary belongs to; deleting the Chat cascades to it. */
  chatId: string;
  /**
   * The last message the summary covers — always an assistant message: a turn
   * boundary. The message that follows it is always a user message, which is
   * what lets the summary text ride the first kept message as a leading text
   * part rather than becoming a message of its own.
   */
  anchorId: string;
  /**
   * The ids of the live Active-path messages from the root to the anchor, in
   * order, as they stood when the summary was taken. A later Delete inside the
   * range is detected against this at read time — nothing is invalidated by a
   * write.
   */
  coveredIds: string[];
  text: string;
  /** What produced the summary, and at what reading — see `TranscriptSummaryStats`. */
  stats: TranscriptSummaryStats | null;
  createdAt: Date;
};

/**
 * What a summary pass recorded about itself. Written from day one so a future
 * "what did a summary cost" display never faces usage that was not recorded,
 * and so a cheaper summariser model can be introduced as a resolver change
 * rather than a schema change (ADR-0041, "Deferred").
 */
export type TranscriptSummaryStats = {
  /**
   * The model that wrote the summary — the Chat's own resolved model
   * (resolved id, not the Agent reference), passed into the summariser as a
   * parameter rather than read inside it.
   */
  modelId: string;
  /** The vendor's input token count for the summary call. */
  inputTokens: number;
  /** The vendor's output token count for the summary call. */
  outputTokens: number;
  /**
   * The occupancy reading the summary was triggered from — the Projected
   * occupancy of the turn whose finish crossed the trigger, or of the turn the
   * backstop fired on. The summary's own output is never part of the trigger
   * reading, so no "after" occupancy is recorded: it cannot be measured
   * without an estimate (ADR-0018).
   */
  triggeredFromOccupancy: number;
};

export const transcriptSummarySchema = z.object({
  id: z.string(),
  chatId: z.string(),
  anchorId: z.string(),
  coveredIds: z.array(z.string()),
  text: z.string(),
  stats: z
    .object({
      modelId: z.string(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      triggeredFromOccupancy: z.number(),
    })
    .nullable(),
  createdAt: z.date(),
});

export type TranscriptSummaryRow = z.infer<typeof transcriptSummarySchema>;
