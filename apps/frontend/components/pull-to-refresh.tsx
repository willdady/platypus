"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import { RefreshCw } from "lucide-react";
import { useTimeout } from "@/hooks/use-timeout";
import { cn } from "@/lib/utils";

const REFRESH_THRESHOLD = 80;
const MAX_PULL_DISTANCE = 120;

const SETTLE_DISTANCE = 15;
const SETTLE_PERIOD_MS = 100;

type PullToRefreshProps = {
  // why: must not reject — callers pass SWR revalidation, which reports failure
  onRefresh: () => Promise<void>;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
};

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
  const scheduleLinger = useTimeout();

  const startYRef = useRef(0);
  const startXRef = useRef(0);
  const startScrollTopRef = useRef(0);
  const isRefreshingRef = useRef(false);
  const isHorizontalRef = useRef(false);
  const firstMoveRef = useRef(true);
  const startTimeRef = useRef(0);
  const disqualifiedRef = useRef(false);
  const settledRef = useRef(false);
  const pullDistanceRef = useRef(0);

  const handleTouchStart = useCallback((e: TouchEvent) => {
    startYRef.current = e.touches[0].clientY;
    startXRef.current = e.touches[0].clientX;
    startScrollTopRef.current = containerRef.current?.scrollTop ?? 0;
    startTimeRef.current = Date.now();
    isHorizontalRef.current = false;
    firstMoveRef.current = true;
    disqualifiedRef.current = false;
    settledRef.current = false;
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

      if (!settledRef.current) {
        const elapsed = Date.now() - startTimeRef.current;
        const totalDelta = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
        if (totalDelta > SETTLE_DISTANCE) {
          disqualifiedRef.current = true;
          return;
        }
        if (elapsed >= SETTLE_PERIOD_MS) {
          settledRef.current = true;
        } else {
          return;
        }
      }

      e.preventDefault();
      const resistance = Math.min(deltaY * 0.45, MAX_PULL_DISTANCE);
      pullDistanceRef.current = resistance;

      setIsPulling(true);
      setPullDistance(resistance);
    },
    [disabled],
  );

  const handleTouchEnd = useCallback(async () => {
    if (isRefreshingRef.current) return;

    const currentPullDistance = pullDistanceRef.current;

    if (currentPullDistance >= REFRESH_THRESHOLD) {
      isRefreshingRef.current = true;
      setIsRefreshing(true);
      setIsPulling(false);
      pullDistanceRef.current = 0;
      setPullDistance(0);
      try {
        await onRefresh();
        // why: linger 600ms so the spinner is seen; an unmount drops the timer
        await new Promise<void>((resolve) => scheduleLinger(resolve, 600));
      } finally {
        isRefreshingRef.current = false;
        setIsRefreshing(false);
      }
    } else {
      setIsPulling(false);
      pullDistanceRef.current = 0;
      setPullDistance(0);
    }
  }, [onRefresh, scheduleLinger]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onTouchEnd = () => void handleTouchEnd();
    el.addEventListener("touchstart", handleTouchStart, { passive: true });
    el.addEventListener("touchmove", handleTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });

    return () => {
      el.removeEventListener("touchstart", handleTouchStart);
      el.removeEventListener("touchmove", handleTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
    };
  }, [handleTouchStart, handleTouchMove, handleTouchEnd]);

  const progress = Math.min(pullDistance / REFRESH_THRESHOLD, 1);
  const showIndicator = isPulling || isRefreshing;

  return (
    <div
      ref={containerRef}
      className={cn("relative [overscroll-behavior-y:contain]", className)}
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
