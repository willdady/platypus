"use client";

import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import type { TranscriptSummaryStats } from "@platypus/schemas";
import type { ChatTranscriptSummary } from "@/lib/chat-summary";
import { formatTokenCount } from "@/lib/token-count";
import { cn } from "@/lib/utils";

/**
 * What the divider says before it is expanded. Plain words on purpose: this is
 * the line a User reads the first time they meet compaction, so it says what
 * happened rather than naming the Context window.
 */
export const SUMMARY_DIVIDER_TEXT =
  "Older messages were summarised for the assistant. They stay readable above.";

/**
 * What the summary pass recorded about itself (ADR-0041): the model that wrote
 * the summary and the vendor's token counts. Both counts at `0` means the
 * Provider reported no usage, so the counts are left out rather than shown as
 * a real zero; `triggeredFromOccupancy` is a diagnostic, not a cost, and is
 * never shown.
 */
function SummaryCost({ stats }: { stats: TranscriptSummaryStats }) {
  const reportedUsage = stats.inputTokens !== 0 || stats.outputTokens !== 0;

  return (
    <p className="mt-2 text-xs text-muted-foreground">
      Summarised by {stats.modelId}
      {reportedUsage && (
        <>
          {" · "}
          {formatTokenCount(stats.inputTokens)} input
          {" · "}
          {formatTokenCount(stats.outputTokens)} output tokens
        </>
      )}
    </p>
  );
}

/**
 * The expandable divider a **Transcript summary** renders at its anchor
 * (ADR-0041, issue #1716): a quiet line in the Transcript that opens to show
 * the summary text and, when the pass recorded it, what the summary cost —
 * which model wrote it and the tokens it used (issue #1733). Every message
 * above it stays fully readable — nothing was deleted, only what the model is
 * sent changed.
 *
 * A divider, not a message: it sits between two messages on the Active path and
 * is never written to the Transcript.
 */
export function TranscriptSummaryDivider({
  summary,
  className,
}: {
  summary: ChatTranscriptSummary;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className={cn("flex flex-col items-stretch", className)}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-md border border-dashed px-3 py-2 text-left text-xs text-muted-foreground hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 transition-transform",
            open && "rotate-90",
          )}
        />
        <span>{SUMMARY_DIVIDER_TEXT}</span>
      </button>
      {open && (
        <div className="mt-2 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
          <p className="whitespace-pre-wrap">{summary.text}</p>
          {summary.stats && <SummaryCost stats={summary.stats} />}
        </div>
      )}
    </div>
  );
}
