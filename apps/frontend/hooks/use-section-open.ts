import { useSyncExternalStore } from "react";

/**
 * Whether the section persisted under `storageKey` was last left open. A
 * section never toggled starts closed. Storage can throw (disabled, or a
 * sandboxed frame), which reads as never toggled.
 */
export function readSectionOpen(storageKey: string): boolean {
  try {
    const stored = localStorage.getItem(storageKey);
    return stored !== null && stored !== "false";
  } catch {
    return false;
  }
}

const subscribeToStorage = (onChange: () => void) => {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
};

/**
 * The persisted open state, read during render so a section mounted on the
 * client paints in its stored state on the first frame instead of painting
 * closed and animating open a frame later. `useSyncExternalStore` keeps it
 * SSR-safe: the server snapshot (closed) is what hydration sees, and the
 * client value follows straight after. Shared with loading placeholders, so a
 * skeleton draws each section collapsed or expanded as it will load.
 */
export function useSectionOpen(storageKey: string): boolean {
  return useSyncExternalStore(
    subscribeToStorage,
    () => readSectionOpen(storageKey),
    () => false,
  );
}
