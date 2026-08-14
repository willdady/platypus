import { TriangleAlertIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The muted warning row shown wherever an answer stopped at the model's output
 * ceiling rather than because the model was finished — under a Chat reply, under
 * a delegated sub-agent response, and in Trigger run history.
 *
 * The row is shared; the wording is not. Each surface names its own subject
 * ("Response", "Sub-agent response", "Run") and owns that sentence as an
 * exported constant its tests assert against.
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
