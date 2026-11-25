import { useSyncExternalStore } from "react";

function readSectionOpen(storageKey: string): boolean {
  try {
    const stored = localStorage.getItem(storageKey);
    return stored !== null && stored !== "false";
  } catch {
    return false;
  }
}

function subscribeToStorage(onChange: () => void) {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

export function useSectionOpen(storageKey: string): boolean {
  // why: read during render, or a section paints closed then animates open
  return useSyncExternalStore(
    subscribeToStorage,
    () => readSectionOpen(storageKey),
    () => false,
  );
}
