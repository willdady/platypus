"use client";

import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

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
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // Reads localStorage (client-only) to restore the persisted open state
    // after mount. Doing this during render would break SSR/hydration, so the
    // setState here is intentional.
    const stored = localStorage.getItem(storageKey);
    if (stored !== null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOpen(stored !== "false");
    }
  }, [storageKey]);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    localStorage.setItem(storageKey, String(next));
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
