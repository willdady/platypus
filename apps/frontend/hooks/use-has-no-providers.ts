import { useScopedList } from "@/hooks/use-scoped-list";
import type { Scope } from "@/lib/api-write";

/**
 * Is the Workspace known to have no Providers? Only a resolved empty read
 * counts: while the read is loading or has failed, `data` is undefined and
 * this is false, so a slow or failed read never looks like "no Providers".
 */
export function useHasNoProviders(scope: Scope): boolean {
  const { data, results } = useScopedList<unknown>("providers", scope);
  return data !== undefined && results.length === 0;
}
