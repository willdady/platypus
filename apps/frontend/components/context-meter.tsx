"use client";

import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

import { useIsMobile } from "@/hooks/use-mobile";
import { formatTokens } from "@/lib/context-window";
import { cn } from "@/lib/utils";

/**
 * How far the mobile row bleeds down over the footer's own padding, matching
 * the `-mb-3` below. The collapsed entrance starts at exactly this height so
 * that height and negative margin cancel: the row occupies nothing, yet the
 * margin never pulls the toolbar up by 12px on its own.
 */
const FOOTER_BLEED = "0.75rem";

/**
 * Reveals a context meter that becomes available after mount on mobile.
 * The caller's `AnimatePresence initial={false}` keeps an initially available
 * meter at its natural height, while desktop and reduced-motion layouts use an
 * immediate transition.
 *
 * The bleed stays in CSS on the clipping box rather than on its content, so the
 * `sm:` breakpoint still governs the resting layout and the tinted band sits
 * inside the box being clipped — a negative margin on the content would shorten
 * the box by 12px and cut the bottom of the band off.
 */
export const ContextMeterEntrance = ({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) => {
  const isMobile = useIsMobile();
  const prefersReducedMotion = useReducedMotion();
  const shouldAnimate = isMobile && !prefersReducedMotion;
  const visible = { height: "auto", opacity: 1 } as const;

  return (
    <motion.div
      initial={shouldAnimate ? { height: FOOTER_BLEED, opacity: 0 } : visible}
      animate={visible}
      transition={{ duration: shouldAnimate ? 0.5 : 0, ease: "easeOut" }}
      className={cn("shrink-0 overflow-hidden -mb-3 sm:mb-0", className)}
    >
      {children}
    </motion.div>
  );
};

/**
 * How full the model's context will be on the next call (ADR-0018).
 *
 * Forward-looking, because it sits in the composer: the figure it shows is the
 * last call's vendor-reported input count PLUS the reply that call produced,
 * since a Chat re-sends its Transcript in full and that reply is part of it now
 * (`nextTurnOccupancy`). It still cannot include an unsent draft — counting
 * tokens locally is the estimate ADR-0018 rejected — so it is one draft behind
 * rather than one turn behind. A retrospective display of a finished run wants
 * plain Context occupancy instead, and the Trigger runs page shows that.
 *
 * Purely presentational: it takes the two numbers and decides only how to show
 * them. Picking the reading off the most recent assistant message, deriving the
 * projection, and taking the declared window off the resolved model all belong
 * to the composing component.
 *
 * Composing callers normally gate on BOTH numbers before mounting this meter,
 * because a numerator with no denominator cannot say whether a value is roomy
 * or nearly fatal. The internal guard remains for safe standalone reuse.
 */
export const ContextMeter = ({
  occupancy,
  contextWindow,
  className,
}: {
  /**
   * What the next model call starts at: the vendor's reported input count for
   * the last call plus its reported output count (`nextTurnOccupancy`).
   * `null` and absent both mean unknown and differ only in why.
   */
  occupancy?: number | null;
  /** The window an Org Admin declared for this model, if any. */
  contextWindow?: number;
  /** Where the meter sits — the composing component's decision, not this one's. */
  className?: string;
}) => {
  if (occupancy == null || contextWindow == null) return null;

  // Clamped, because under-declaring a window is the SAFE direction and
  // therefore expected: a 128k declaration against a real 200k model is a
  // deliberate choice, not a fault, and must not render as 117% or a bar
  // overflowing its track. The figures below stay true.
  const percent = Math.min(100, Math.round((occupancy / contextWindow) * 100));
  const used = formatTokens(occupancy);
  const total = formatTokens(contextWindow);

  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground",
        className,
      )}
    >
      <div
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Context used"
        // Tinted from the foreground rather than `bg-muted`, whose dark value
        // sits close enough to the composer's own surface that the empty part
        // of the track disappears and the bar loses the length it is read
        // against.
        //
        // Longer on a narrow screen, where the meter has a row to itself and
        // the width no longer competes with the tools beside it — and a longer
        // track is a finer reading, since every pixel is a percent and a bit.
        className="h-1 w-16 overflow-hidden rounded-full bg-muted-foreground/25 sm:w-10"
      >
        <div
          className="h-full rounded-full bg-muted-foreground/70"
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="tabular-nums whitespace-nowrap">
        {percent}% · {used}/{total}
      </span>
    </div>
  );
};
