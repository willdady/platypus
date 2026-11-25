"use client";

import { MotionConfig } from "motion/react";
import type { ReactNode } from "react";

// why: MotionConfig skips transforms only — a looping animation checks useReducedMotion
export function MotionProvider({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
