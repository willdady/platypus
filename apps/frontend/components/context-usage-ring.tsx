"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Loader2 } from "lucide-react";

/**
 * Context-usage ring (context-compaction-plan §H + §J).
 *
 * Renders a small SVG donut ring showing `usedTokens / contextWindow` fill.
 * Colours: green < 0.7, amber >= 0.7, red >= 0.9.
 * Shows neutral grey with no percentage when contextWindow is unknown/default
 * (drift T6) or when no run has completed yet.
 *
 * When `onClick` is provided the ring is clickable (§J: compact on demand).
 * - While `isPending` (click queued, waiting for streaming to finish): shows
 *   a pending badge and is disabled (drift U4).
 * - While `isCompacting`: shows a spinner.
 * - `isStreaming` disables clicks entirely (frontend defers via pending flag).
 */
export function ContextUsageRing({
  usedTokens,
  contextWindow,
  onClick,
  isStreaming,
  isPending,
  isCompacting,
}: {
  usedTokens?: number;
  contextWindow?: number | null;
  onClick?: () => void;
  isStreaming?: boolean;
  isPending?: boolean;
  isCompacting?: boolean;
}) {
  const r = 7;
  const circumference = 2 * Math.PI * r;

  const isNeutral = !contextWindow || usedTokens === undefined;
  const fill = isNeutral
    ? 0
    : Math.min(1, Math.max(0, usedTokens / contextWindow));

  const color = isNeutral
    ? "var(--color-muted-foreground)"
    : fill >= 0.9
      ? "var(--color-destructive)"
      : fill >= 0.7
        ? "#f59e0b"
        : "var(--color-primary)";

  const isDisabled = isPending || isCompacting || isStreaming || !onClick;
  const isClickable = !!onClick && !isDisabled;

  // Append the compact affordance whenever the ring is actually clickable —
  // including the neutral (unknown-window) state, where the user can still
  // force a compaction even though no fill is shown.
  const clickHint = isClickable ? " · click to compact" : "";
  let tooltipLabel: string;
  if (isPending) {
    tooltipLabel = "Will compact when response finishes";
  } else if (isCompacting) {
    tooltipLabel = "Compacting…";
  } else if (isNeutral) {
    if (!contextWindow) {
      tooltipLabel = `Context window unknown · model not found in provider registry${clickHint}`;
    } else {
      tooltipLabel = `No messages yet · ${contextWindow.toLocaleString()} token window${clickHint}`;
    }
  } else {
    tooltipLabel = `Last response: ${usedTokens!.toLocaleString()} / ${contextWindow!.toLocaleString()} (${Math.round(fill * 100)}%) · current input not yet counted${clickHint}`;
  }

  return (
    <Tooltip delayDuration={500}>
      <TooltipTrigger asChild>
        <div
          className={`flex items-center justify-center w-8 h-8 relative ${isClickable ? "cursor-pointer hover:opacity-70 transition-opacity" : "cursor-default"}`}
          onClick={isClickable ? onClick : undefined}
          onKeyDown={
            isClickable
              ? (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onClick!();
                  }
                }
              : undefined
          }
          tabIndex={isClickable ? 0 : undefined}
          role={isClickable ? "button" : undefined}
          aria-label={tooltipLabel}
          aria-disabled={isDisabled || undefined}
        >
          {isCompacting ? (
            <Loader2 size={16} className="animate-spin text-muted-foreground" />
          ) : (
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
              {/* Track */}
              <circle
                cx="10"
                cy="10"
                r={r}
                fill="none"
                stroke="var(--color-border)"
                strokeWidth="3"
              />
              {/* Fill */}
              <circle
                cx="10"
                cy="10"
                r={r}
                fill="none"
                stroke={isPending ? "var(--color-muted-foreground)" : color}
                strokeWidth="3"
                strokeDasharray={`${circumference}`}
                strokeDashoffset={`${circumference * (1 - fill)}`}
                strokeLinecap="butt"
                transform="rotate(-90 10 10)"
                style={{ transition: "stroke-dashoffset 0.3s ease" }}
              />
              {/* Pending dot */}
              {isPending && <circle cx="10" cy="3.5" r="2" fill="#f59e0b" />}
            </svg>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-center text-xs">
        {tooltipLabel}
      </TooltipContent>
    </Tooltip>
  );
}
