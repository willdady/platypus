"use client";

import type { ReactNode } from "react";
import { ListError } from "@/components/list-state";
import { LoadingRegion } from "@/components/list-skeletons";

/**
 * The table analogue of `EntityCardList` (#1851): the admin tables' one
 * loading → failed read → empty → table ladder. Only a cold failure replaces
 * the table (`error && !data`); a read that fails a revalidation keeps the
 * rows already in hand, as `DetailFormState` does for a detail form.
 *
 * The caller owns the read, the rows and the dialogs around them; `skeleton`
 * and `empty` fill in the two states, and `children` is the loaded table.
 */
export function TableList({
  isLoading,
  data,
  error,
  subject,
  skeleton,
  empty,
  isEmpty,
  onRetry,
  children,
}: {
  isLoading: boolean;
  /** The read's data. Absent with an error means the read failed cold. */
  data: unknown;
  error: unknown;
  /** The plural noun loading or failing to load: "members", "users". */
  subject: string;
  /** Drawn in the loading region: the table's `TableSkeleton`. */
  skeleton: ReactNode;
  /** Drawn when the read has landed with no rows: an `EmptyCard` or `ListState`. */
  empty: ReactNode;
  /** True once the landed read holds no rows. */
  isEmpty: boolean;
  /** Reads the list again after a failed read; without it there is no Retry. */
  onRetry?: () => void;
  /** The loaded table. */
  children: ReactNode;
}) {
  if (isLoading) {
    return (
      <LoadingRegion label={`Loading ${subject}`}>{skeleton}</LoadingRegion>
    );
  }

  if (error && !data) {
    return <ListError error={error} subject={subject} onRetry={onRetry} />;
  }

  if (isEmpty) {
    return <>{empty}</>;
  }

  return <>{children}</>;
}
