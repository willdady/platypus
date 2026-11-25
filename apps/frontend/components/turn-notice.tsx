import { TriangleAlertIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export const RUN_CUT_SHORT_NOTICE =
  "Run cut short at the model's output limit.";

export const RUN_STEP_LIMIT_NOTICE =
  "Run cut short at the step limit. Raise Max steps to let it finish.";

export function TurnNotice({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        // why: items-start keeps the icon on line one when a notice wraps
        "flex items-start gap-1.5 text-muted-foreground text-xs",
        className,
      )}
    >
      <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}
