"use client";

import { useState, type ReactNode } from "react";
import { ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

/**
 * The collapsed "Advanced settings" block the entity forms share: a heading
 * and a toggle, closed until opened, with the caller's fields inside. The
 * toggle is a real button so it is reachable and operable by keyboard, and the
 * heading text is the control's accessible name.
 */
export function FormAdvancedSection({
  children,
  className,
  contentClassName,
}: {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className={className}>
      <CollapsibleTrigger asChild>
        <div className="flex text-sm justify-between items-center">
          <span className="cursor-default">Advanced settings</span>
          <Button variant="ghost" size="icon-sm">
            <ChevronsUpDown />
            <span className="sr-only">Toggle</span>
          </Button>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent className={contentClassName}>
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
