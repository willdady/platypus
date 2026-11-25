"use client";

import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import type { TranscriptSummaryStats } from "@platypus/schemas";
import type { ChatTranscriptSummary } from "@/lib/chat-summary";
import { formatTokenCount } from "@/lib/token-count";
import { cn } from "@/lib/utils";

// why: plain words — this line first meets compaction, before Context window
export const SUMMARY_DIVIDER_TEXT =
  "Older messages were summarised for the assistant. They stay readable above.";

// why: 0 means unreported, so it is omitted; occupancy is diagnostic, not cost
function SummaryCost({ stats }: { stats: TranscriptSummaryStats }) {
  const counts: string[] = [];
  if (stats.inputTokens !== 0) {
    counts.push(`${formatTokenCount(stats.inputTokens)} input`);
  }
  if (stats.outputTokens !== 0) {
    counts.push(`${formatTokenCount(stats.outputTokens)} output`);
  }

  return (
    <p className="mt-2 text-xs text-muted-foreground">
      Summarised by {stats.modelId}
      {counts.length > 0 && <> · {counts.join(" · ")} tokens</>}
    </p>
  );
}

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
