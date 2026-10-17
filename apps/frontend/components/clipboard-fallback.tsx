"use client";

import { useEffect } from "react";
import { installClipboardFallback } from "@/lib/clipboard";

/** Installs {@link installClipboardFallback} once, from the root layout. */
export function ClipboardFallback() {
  useEffect(installClipboardFallback, []);
  return null;
}
