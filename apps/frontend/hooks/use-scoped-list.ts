import type { SWRConfiguration, SWRResponse } from "swr";
import type { Scope } from "@/lib/api-write";
import { useScopedSWR } from "./use-scoped-swr";

// One instance, so an empty list keeps its reference across renders (no
// `useMemo` at the call site). Shared, so callers sort a copy, never in place.
const EMPTY: never[] = [];

/**
 * A list read: `useScopedSWR` on a `{ results: T[] }` endpoint, plus
 * `results` — the unwrapped rows, or `[]` until a read has landed (loading,
 * a failed first read, or a `null` scope). `data` and `mutate` keep the envelope, so optimistic updates
 * still write `{ results }`.
 *
 * `results` is a getter layered over SWR's response rather than a spread of
 * it: spreading reads every SWR getter and subscribes the caller to all of
 * its state (see `useScopedSWR`).
 */
export function useScopedList<T>(
  entity: string,
  scope: Scope | null,
  config?: SWRConfiguration<{ results: T[] }>,
): SWRResponse<{ results: T[] }> & { results: T[] } {
  const response = useScopedSWR<{ results: T[] }>(entity, scope, config);
  return Object.create(response, {
    results: { get: () => response.data?.results ?? EMPTY },
  });
}
