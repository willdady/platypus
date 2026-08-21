import { TriangleAlertIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The muted warning row for a per-turn notice about how an answer was produced
 * or how it ended — under a Chat reply, under a delegated sub-agent response,
 * and in Trigger run history.
 *
 * It began as the output-ceiling row and keeps the name; it now also carries
 * the search-was-unavailable notice, and a Chat reply can show both at once.
 *
 * The row is shared; the wording is not. Each surface owns its own sentence as
 * an exported constant its tests assert against — the ceiling notices name
 * their subject ("Response", "Sub-agent response", "Run") per surface.
 */
export const CutShortNotice = ({
  children,
  className,
}: {
  children: string;
  className?: string;
}) => (
  <div
    className={cn(
      "flex items-center gap-1.5 text-muted-foreground text-xs",
      className,
    )}
  >
    <TriangleAlertIcon className="size-3.5 shrink-0" />
    <span>{children}</span>
  </div>
);
