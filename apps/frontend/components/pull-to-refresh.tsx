"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import { RefreshCw } from "lucide-react";

/** How far the finger must travel before releasing triggers a refresh. */
const REFRESH_THRESHOLD = 80;
/** The furthest the indicator is dragged, however far the finger goes. */
const MAX_PULL_DISTANCE = 120;

// The finger must remain within this many pixels of the start point for the
// duration of SETTLE_PERIOD_MS. If the finger moves further before the settle
// period elapses, the entire gesture is disqualified from pull-to-refresh.
const SETTLE_DISTANCE = 15;
const SETTLE_PERIOD_MS = 100;

interface PullToRefreshProps {
  onRefresh: () => Promise<void>;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}

/**
 * A touch gesture that refreshes by pulling down from the top of a scroll
 * container. The gesture handling and the indicator it drives live together
 * here because they are one behaviour with one caller.
 */
export function PullToRefresh({
  onRefresh,
  disabled = false,
  className,
  children,
}: PullToRefreshProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isPulling, setIsPulling] = useState(false);

  const startYRef = useRef(0);
  const startXRef = useRef(0);
  const startScrollTopRef = useRef(0);
  const isRefreshingRef = useRef(false);
  const isHorizontalRef = useRef(false);
  const firstMoveRef = useRef(true);
  const startTimeRef = useRef(0);
  // Whether the gesture has been permanently disqualified (moved too fast)
  const disqualifiedRef = useRef(false);
  // Whether the settle period has passed and the gesture is qualified
  const settledRef = useRef(false);
  // Ref mirrors so callbacks never read stale state
  const pullDistanceRef = useRef(0);
  const isPullingRef = useRef(false);

  const handleTouchStart = useCallback((e: TouchEvent) => {
    startYRef.current = e.touches[0].clientY;
    startXRef.current = e.touches[0].clientX;
    startScrollTopRef.current = containerRef.current?.scrollTop ?? 0;
    startTimeRef.current = Date.now();
    isHorizontalRef.current = false;
    firstMoveRef.current = true;
    disqualifiedRef.current = false;
    settledRef.current = false;
    isPullingRef.current = false;
    pullDistanceRef.current = 0;
  }, []);

  const handleTouchMove = useCallback(
    (e: TouchEvent) => {
      if (disabled || isRefreshingRef.current || disqualifiedRef.current)
        return;

      const touch = e.touches[0];
      const deltaY = touch.clientY - startYRef.current;
      const deltaX = touch.clientX - startXRef.current;

      if (firstMoveRef.current) {
        firstMoveRef.current = false;
        if (Math.abs(deltaX) > Math.abs(deltaY)) {
          isHorizontalRef.current = true;
          return;
        }
      }

      if (isHorizontalRef.current) return;
      if (startScrollTopRef.current !== 0) return;
      if (deltaY <= 0) return;

      // During the settle period, check if the finger has moved too far.
      // If so, permanently disqualify this gesture.
      if (!settledRef.current) {
        const elapsed = Date.now() - startTimeRef.current;
        const totalDelta = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
        if (totalDelta > SETTLE_DISTANCE) {
          // Finger moved too far before settle period elapsed — disqualify
          disqualifiedRef.current = true;
          return;
        }
        if (elapsed >= SETTLE_PERIOD_MS) {
          // Finger stayed still long enough — gesture is qualified
          settledRef.current = true;
        } else {
          // Still within settle period and within distance — wait
          return;
        }
      }

      e.preventDefault();
      const resistance = Math.min(deltaY * 0.45, MAX_PULL_DISTANCE);
      pullDistanceRef.current = resistance;

      isPullingRef.current = true;
      setIsPulling(true);
      setPullDistance(resistance);
    },
    [disabled],
  );

  const handleTouchEnd = useCallback(async () => {
    if (isRefreshingRef.current) return;

    const currentPullDistance = pullDistanceRef.current;
    isPullingRef.current = false;

    if (currentPullDistance >= REFRESH_THRESHOLD) {
      isRefreshingRef.current = true;
      setIsRefreshing(true);
      setIsPulling(false);
      pullDistanceRef.current = 0;
      setPullDistance(0);
      try {
        await onRefresh();
        // Linger so the spinner is visible before the indicator exits
        await new Promise<void>((resolve) => setTimeout(resolve, 600));
      } finally {
        isRefreshingRef.current = false;
        setIsRefreshing(false);
      }
    } else {
      setIsPulling(false);
      pullDistanceRef.current = 0;
      setPullDistance(0);
    }
  }, [onRefresh]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    el.addEventListener("touchstart", handleTouchStart, { passive: true });
    el.addEventListener("touchmove", handleTouchMove, { passive: false });
    el.addEventListener("touchend", handleTouchEnd, { passive: true });

    return () => {
      el.removeEventListener("touchstart", handleTouchStart);
      el.removeEventListener("touchmove", handleTouchMove);
      el.removeEventListener("touchend", handleTouchEnd);
    };
  }, [handleTouchStart, handleTouchMove, handleTouchEnd]);

  const progress = Math.min(pullDistance / REFRESH_THRESHOLD, 1);
  const showIndicator = isPulling || isRefreshing;

  return (
    <div
      ref={containerRef}
      className={`relative [overscroll-behavior-y:contain] ${className ?? ""}`}
    >
      <AnimatePresence>
        {showIndicator && (
          <motion.div
            key="ptr-indicator"
            initial={{ opacity: 0, y: -40 }}
            animate={{
              opacity: 1,
              y: isRefreshing ? 16 : pullDistance / 2 - 20,
            }}
            exit={{ opacity: 0, y: -40 }}
            transition={{ duration: 0.15 }}
            className="absolute left-1/2 top-0 z-50 -translate-x-1/2"
          >
            <div className="flex size-12 items-center justify-center rounded-full bg-background shadow-md border">
              <motion.div
                key={isRefreshing ? "refreshing" : "pulling"}
                initial={{ rotate: 0 }}
                animate={
                  isRefreshing ? { rotate: 360 } : { rotate: progress * 270 }
                }
                transition={
                  isRefreshing
                    ? { duration: 0.8, repeat: Infinity, ease: "linear" }
                    : { duration: 0 }
                }
              >
                <RefreshCw className="size-5 text-foreground" />
              </motion.div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {children}
    </div>
  );
}
