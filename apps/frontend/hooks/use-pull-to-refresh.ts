import { useRef, useState, useCallback, useEffect } from "react";

interface UsePullToRefreshOptions {
  onRefresh: () => Promise<void>;
  threshold?: number;
  maxPullDistance?: number;
  disabled?: boolean;
}

interface UsePullToRefreshReturn {
  containerRef: React.RefObject<HTMLDivElement | null>;
  pullDistance: number;
  isRefreshing: boolean;
  isPulling: boolean;
}

// The finger must remain within this many pixels of the start point for the
// duration of SETTLE_PERIOD_MS. If the finger moves further before the settle
// period elapses, the entire gesture is disqualified from pull-to-refresh.
const SETTLE_DISTANCE = 15;
const SETTLE_PERIOD_MS = 100;

export function usePullToRefresh({
  onRefresh,
  threshold = 80,
  maxPullDistance = 120,
  disabled = false,
}: UsePullToRefreshOptions): UsePullToRefreshReturn {
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
      const resistance = Math.min(deltaY * 0.45, maxPullDistance);
      pullDistanceRef.current = resistance;

      isPullingRef.current = true;
      setIsPulling(true);
      setPullDistance(resistance);
    },
    [disabled, maxPullDistance],
  );

  const handleTouchEnd = useCallback(async () => {
    if (isRefreshingRef.current) return;

    const currentPullDistance = pullDistanceRef.current;
    isPullingRef.current = false;

    if (currentPullDistance >= threshold) {
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
  }, [threshold, onRefresh]);

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

  return { containerRef, pullDistance, isRefreshing, isPulling };
}
