import { TriangleAlertIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The Trigger-run wording for the two ceilings. The row is shared but the
 * wording is not: a Trigger run says "Run" where a Chat reply names its own
 * subject. Exported so tests assert the wording without restating the prose.
 */
export const RUN_CUT_SHORT_NOTICE =
  "Run cut short at the model's output limit.";

/** The same for a run whose tool-calling loop hit its step ceiling. */
export const RUN_STEP_LIMIT_NOTICE = "Run cut short at the step limit.";

/**
 * The muted warning row for a per-turn notice about how an answer was produced
 * or how it ended — under a Chat reply, under a delegated Sub-Agent response,
 * and in Trigger run history.
 *
 * It carries the two cut-short notices — the output ceiling and the step
 * ceiling, never both of one turn — and the search-was-unavailable notice. A
 * Chat reply can show a cut-short row and the search row at once: how the reply
 * was produced, then how it ended.
 *
 * The row is shared; the wording is not. Each surface owns its own sentence as
 * an exported constant its tests assert against — the ceiling notices name
 * their subject ("Response", "Sub-Agent response", "Run") per surface.
 */
export const TurnNotice = ({
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
