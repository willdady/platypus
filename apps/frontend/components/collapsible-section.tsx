"use client";

import { useState, useSyncExternalStore } from "react";
import { ChevronDown } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

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

interface CollapsibleSectionProps {
  title: React.ReactNode;
  description?: string;
  storageKey: string;
  children: React.ReactNode;
  className?: string;
}

export function CollapsibleSection({
  title,
  description,
  storageKey,
  children,
  className,
}: CollapsibleSectionProps) {
  const stored = useSectionOpen(storageKey);
  // A toggle made here wins over what storage says, so the section still
  // opens and closes where storage can't be written.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? stored;

  const handleOpenChange = (next: boolean) => {
    setToggled(next);
    try {
      localStorage.setItem(storageKey, String(next));
    } catch {
      // Not persisted; the in-memory state above still applies.
    }
  };

  return (
    <Collapsible
      open={open}
      onOpenChange={handleOpenChange}
      className={className}
    >
      <CollapsibleTrigger className="group flex w-full items-start justify-between gap-2 text-left">
        <div className="flex flex-col">
          <h2 className="text-xl font-semibold tracking-tight flex items-center gap-2">
            {title}
          </h2>
          {description && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        <ChevronDown className="mt-1 h-5 w-5 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-0 group-data-[state=closed]:-rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up overflow-hidden">
        <div className="space-y-4 pt-4">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
