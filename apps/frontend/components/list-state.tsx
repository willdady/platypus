"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type ListStateVariant = "empty" | "error";

const TONE: Record<ListStateVariant, string> = {
  empty: "text-muted-foreground",
  error: "text-destructive",
};

const FRAME: Record<ListStateVariant, string> = {
  empty: "rounded-lg border-2 border-dashed",
  error: "",
};

export function ListState({
  variant,
  children,
  action,
}: {
  variant: ListStateVariant;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 py-8",
        FRAME[variant],
      )}
    >
      <p className={cn("text-sm", TONE[variant])}>{children}</p>
      {action}
    </div>
  );
}

type ReadError = {
  readonly message?: string;
  readonly info?: { readonly error?: unknown };
};

export function ListError({
  error,
  subject,
  onRetry,
}: {
  error: unknown;
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
