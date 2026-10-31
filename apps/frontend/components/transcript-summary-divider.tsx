"use client";

import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import type { ChatTranscriptSummary } from "@/lib/chat-summary";
import { cn } from "@/lib/utils";

/**
 * What the divider says before it is expanded. Plain words on purpose: this is
 * the line a User reads the first time they meet compaction, so it says what
 * happened rather than naming the Context window.
 */
export const SUMMARY_DIVIDER_TEXT =
  "Older messages were summarised for the assistant. They stay readable above.";

/**
 * The expandable divider a **Transcript summary** renders at its anchor
 * (ADR-0041, issue #1716): a quiet line in the Transcript that opens to show
 * the summary text. Every message above it stays fully readable — nothing was
 * deleted, only what the model is sent changed.
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
        <div className="mt-2 whitespace-pre-wrap rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
          {summary.text}
        </div>
      )}
    </div>
  );
}
