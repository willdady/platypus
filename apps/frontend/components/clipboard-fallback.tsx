"use client";

import { useEffect } from "react";
import { installClipboardFallback } from "@/lib/clipboard";

export function ClipboardFallback() {
  useEffect(installClipboardFallback, []);
  return null;
}
