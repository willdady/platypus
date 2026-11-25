import { useState } from "react";
import { toast } from "sonner";
import type { WriteOutcome } from "@/lib/api-write";

type Override<T> = Partial<T> | null;

export function useOptimisticRows<T extends { readonly id: string }>() {
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
    // why: each run owns its entry, so it clears only the override it set
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
