"use client";

import { MotionConfig } from "motion/react";
import type { ReactNode } from "react";

/**
 * Honours the OS "reduce motion" setting for every Motion animation: with it
 * on, transform and layout animations are skipped. Components that loop or
 * flash other properties check `useReducedMotion` themselves.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
