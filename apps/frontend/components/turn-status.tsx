import { cn } from "@/lib/utils";

/**
 * A transient per-turn status row — the line a turn streams while it waits for
 * something before it can answer, such as a **Transcript summary** (ADR-0041).
 *
 * The same row is shown where the reply will appear in the transcript and
 * above the composer, so the wait reads the same wherever the reader is
 * looking. `announce` is false on a copy that is visual only, so a screen
 * reader announces the wait once rather than twice.
 */
export function TurnStatus({
  children,
  announce = true,
  className,
}: {
  children: string;
  /** Whether this copy is the live region for the text. */
  announce?: boolean;
  className?: string;
}) {
  return (
    <p
      role={announce ? "status" : undefined}
      className={cn("text-xs text-muted-foreground", className)}
    >
      {children}
    </p>
  );
}
