"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

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
}: {
  variant: ListStateVariant;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-center py-8">
      <p className={cn("text-sm", TONE[variant])}>{children}</p>
    </div>
  );
}

/** The shape SWR puts on `error`, whether the failure carries an `info` or not. */
interface ReadError {
  readonly message?: string;
  readonly info?: { readonly message?: string };
}

/**
 * The fetch-failure state shared by every list: "Failed to load <subject>." plus
 * the reader's reason. Owns the SWR `error.info?.message || error.message`
 * fallback that was copy-pasted into every list.
 */
export function ListError({
  error,
  subject,
}: {
  error: unknown;
  /** The plural noun named in the failure: "agents", "MCP servers". */
  subject: string;
}) {
  const { message, info } = (error ?? {}) as ReadError;
  return (
    <ListState variant="error">
      Failed to load {subject}. {info?.message || message}
    </ListState>
  );
}
