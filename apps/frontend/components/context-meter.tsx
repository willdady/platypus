"use client";

import { motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import type { ReactNode } from "react";

import { useIsMobile } from "@/hooks/use-mobile";
import { formatTokens } from "@/lib/context-window";
import { cn } from "@/lib/utils";

// why: the collapsed height and its negative margin must cancel
const FOOTER_BLEED = "0.75rem";

// why: the bleed stays on the clipping box; on content it would cut the band
export function ContextMeterEntrance({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
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
      data-testid="context-meter-entrance"
    >
      {children}
    </motion.div>
  );
}

// why: with no denominator the meter is gone, but the hint names what else is off
export function ContextWindowHint({
  href,
  className,
}: {
  href: string;
  className?: string;
}) {
  return (
    <p className={cn("shrink-0 text-xs text-muted-foreground", className)}>
      No Context window set: long Chats aren&apos;t condensed ahead of time.{" "}
      <Link
        href={href}
        className="underline underline-offset-2 hover:text-foreground"
      >
        Add a Context window in Provider settings
      </Link>
    </p>
  );
}

// why: the next call resends the transcript, so this is the last call plus its reply
export function ContextMeter({
  occupancy,
  contextWindow,
  className,
}: {
  occupancy?: number | null;
  contextWindow?: number;
  className?: string;
}) {
  if (occupancy == null || contextWindow == null) return null;

  // why: under-declaring is safe and expected, so clamp rather than show 117%
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
        // why: bg-muted/25 disappears against the composer; tint from the foreground
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
}
