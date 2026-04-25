"use client";

import { AnimatePresence, motion } from "motion/react";
import { RefreshCw } from "lucide-react";
import { usePullToRefresh } from "@/hooks/use-pull-to-refresh";

interface PullToRefreshProps {
  onRefresh: () => Promise<void>;
  threshold?: number;
  maxPullDistance?: number;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}

export function PullToRefresh({
  onRefresh,
  threshold = 80,
  maxPullDistance = 120,
  disabled = false,
  className,
  children,
}: PullToRefreshProps) {
  const { containerRef, pullDistance, isRefreshing, isPulling } =
    usePullToRefresh({ onRefresh, threshold, maxPullDistance, disabled });

  const progress = Math.min(pullDistance / threshold, 1);
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
