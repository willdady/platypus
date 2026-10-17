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
  const [overrides, setOverrides] = useState<ReadonlyMap<string, Override<T>>>(
    new Map(),
  );

  const setOverride = (id: string, override?: Override<T>) =>
    setOverrides((prev) => {
      const next = new Map(prev);
      if (override === undefined) next.delete(id);
      else next.set(id, override);
      return next;
    });

  const apply = (rows: readonly T[]): T[] =>
    rows.flatMap((row) => {
      if (!overrides.has(row.id)) return [row];
      const override = overrides.get(row.id);
      return override ? [{ ...row, ...override }] : [];
    });

  const run = async (
    id: string,
    override: Override<T>,
    write: () => Promise<WriteOutcome<unknown>>,
    revalidate: () => unknown,
  ) => {
    setOverride(id, override);
    try {
      const outcome = await write();
      if (outcome.outcome === "success") {
        await revalidate();
      } else {
        toast.error(outcome.message);
      }
    } finally {
      setOverride(id);
    }
  };

  return { apply, run, isPending: (id: string) => overrides.has(id) };
}
