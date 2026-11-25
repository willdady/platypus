import { useScopedList } from "@/hooks/use-scoped-list";
import type { Scope } from "@/lib/api-write";

export function useHasNoProviders(scope: Scope): boolean {
  const { data, results } = useScopedList<unknown>("providers", scope);
  // why: a loading or failed read has no data, so it never reads as no Providers
  return data !== undefined && results.length === 0;
}
