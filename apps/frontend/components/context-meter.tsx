"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * How full the model's context was on the last completed turn (ADR-0018).
 *
 * Purely presentational: it takes the two numbers and decides only how to show
 * them. Picking the reading off the most recent assistant message, and the
 * declared window off the resolved model, belongs to the composing component.
 *
 * Renders nothing unless BOTH numbers are known — one hidden state with two
 * causes (no window declared, or the Provider reported no usage). A numerator
 * with no denominator would be a third display mode answering none of the
 * questions a meter exists for: a bare "42,000 tokens" cannot say whether that
 * is roomy or nearly fatal.
 */
export const ContextMeter = ({
  occupancy,
  contextWindow,
}: {
  /**
   * Input tokens the vendor reported for the last model call of the turn.
   * `null` and absent both mean unknown and differ only in why.
   */
  occupancy?: number | null;
  /** The window an Org Admin declared for this model, if any. */
  contextWindow?: number;
}) => {
  if (occupancy == null || contextWindow == null) return null;

  // Clamped, because under-declaring a window is the SAFE direction and
  // therefore expected: a 128k declaration against a real 200k model is a
  // deliberate choice, not a fault, and must not render as 117% or a bar
  // overflowing its track. The figures below stay true.
  const percent = Math.min(100, Math.round((occupancy / contextWindow) * 100));
  const used = occupancy.toLocaleString();
  const total = contextWindow.toLocaleString();

  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <div className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <div
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Context used"
            className="h-1 w-10 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-muted-foreground/60"
              style={{ width: `${percent}%` }}
            />
          </div>
          <span className="tabular-nums whitespace-nowrap">
            {percent}% · {used}/{total}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent>
        {/* One turn stale, and said so: nothing can count the tokens of a draft
            locally, so the reading describes the last turn that was sent. */}
        {used} of {total} tokens after the last turn.
      </TooltipContent>
    </Tooltip>
  );
};
