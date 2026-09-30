"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type ListStateVariant = "empty" | "error";

const TONE: Record<ListStateVariant, string> = {
  empty: "text-muted-foreground",
  error: "text-destructive",
};

/**
 * The empty / error state every list shows (#877). Each list supplies only the
 * copy that differs; tone and the centered frame live here, so the states stop
 * drifting apart across lists. Loading is a skeleton of the list's own rows
 * instead (`list-skeletons`).
 */
export function ListState({
  variant,
  children,
  action,
}: {
  variant: ListStateVariant;
  children: ReactNode;
  /** A control under the message, e.g. a failed read's Retry. */
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-8">
      <p className={cn("text-sm", TONE[variant])}>{children}</p>
      {action}
    </div>
  );
}

/**
 * The shape SWR puts on `error`, whether the failure carries an `info` or not.
 * `info` is the response body, whose failure reason is under `error`.
 */
interface ReadError {
  readonly message?: string;
  readonly info?: { readonly error?: unknown };
}

/**
 * The fetch-failure state shared by every list: "Failed to load <subject>." plus
 * the reader's reason — the body's `error` when it is a string (a validation
 * failure's is an object, which can't render), else the error's own message.
 * Given `onRetry` (the read's `mutate`), it offers to read again, so a
 * transient failure needn't mean a page reload.
 */
export function ListError({
  error,
  subject,
  onRetry,
}: {
  error: unknown;
  /** The plural noun named in the failure: "agents", "MCP servers". */
  subject: string;
  onRetry?: () => void;
}) {
  const { message, info } = (error ?? {}) as ReadError;
  const reason = typeof info?.error === "string" ? info.error : message;
  return (
    <ListState
      variant="error"
      action={
        onRetry && (
          <Button variant="outline" size="sm" onClick={() => onRetry()}>
            Retry
          </Button>
        )
      }
    >
      Failed to load {subject}. {reason}
    </ListState>
  );
}
