import { useState } from "react";
import { toast } from "sonner";
import type { WriteOutcome } from "@/lib/api-write";

/** A row's optimistic state: fields to show over it, or `null` to hide it. */
type Override<T> = Partial<T> | null;

/**
 * Shows a row's write before the server answers. `run` lays the override over
 * the row, sends the write, and on success revalidates before dropping the
 * override, so the row never flickers back. A refusal drops it at once (the
 * row reverts) and is toasted.
 *
 * Overrides are per row, so several rows can be in flight together and a
 * revalidation landing for one doesn't undo another still pending. Render the
 * list through `apply`; `isPending` is true only while that row's write runs.
 */
export function useOptimisticRows<T extends { readonly id: string }>() {
  // Each run's entry is its own object, so a run only clears the override it
  // set, not one a later write on the same row laid over it.
  const [overrides, setOverrides] = useState<
    ReadonlyMap<string, { readonly override: Override<T> }>
  >(new Map());

  const apply = (rows: readonly T[]): T[] =>
    rows.flatMap((row) => {
      const entry = overrides.get(row.id);
      if (!entry) return [row];
      return entry.override ? [{ ...row, ...entry.override }] : [];
    });

  const run = async (
    id: string,
    override: Override<T>,
    write: () => Promise<WriteOutcome<unknown>>,
    revalidate: () => unknown,
  ) => {
    const entry = { override };
    setOverrides((prev) => new Map(prev).set(id, entry));
    try {
      const outcome = await write();
      if (outcome.outcome === "success") {
        await revalidate();
      } else {
        toast.error(outcome.message);
      }
    } finally {
      setOverrides((prev) => {
        if (prev.get(id) !== entry) return prev;
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    }
  };

  return { apply, run, isPending: (id: string) => overrides.has(id) };
}
