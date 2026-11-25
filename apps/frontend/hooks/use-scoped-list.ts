import type { SWRConfiguration, SWRResponse } from "swr";
import type { Scope, Serialized } from "@/lib/api-write";
import { useScopedSWR } from "./use-scoped-swr";

// why: one shared array, so callers sort a copy and never in place
const EMPTY: never[] = [];

export function useScopedList<T>(
  entity: string,
  scope: Scope | null,
  config?: SWRConfiguration<Serialized<{ results: T[] }>>,
): ScopedList<T> {
  const response = useScopedSWR<{ results: T[] }>(entity, scope, config);
  return Object.create(response, {
    results: { get: () => response.data?.results ?? EMPTY },
  }) as ScopedList<T>;
}

type ScopedList<T> = SWRResponse<Serialized<{ results: T[] }>, unknown> & {
  results: Serialized<T>[];
};
