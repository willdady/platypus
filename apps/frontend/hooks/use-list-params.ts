import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { pageOf, type Page } from "@/components/list-pagination";
import { replaceSearchParam } from "@/lib/search-params";

/**
 * A list's filters and page, read from and written to the URL so they survive
 * a refresh, Back and a shared link.
 *
 * `set` writes through `replaceSearchParam`, leaving an empty or `null` value
 * out, and starts the list on page 1: a new filter is a new result set. Pass
 * no `pageParam` for a list that is not paged, as Trigger runs is not.
 */
export function useListParams(pageParam?: string) {
  const searchParams = useSearchParams();

  /** The param's raw value, or `null` when the URL leaves it out. */
  const get = (key: string) => searchParams.get(key);

  /** Writes one filter, dropping a default value, and resets the page. */
  const set = (key: string, value: string | null) => {
    replaceSearchParam(key, value);
    if (pageParam) replaceSearchParam(pageParam, null);
  };

  /** The page of `items` the URL asks for; page 1 when it is not paged. */
  const page = <T>(items: readonly T[], pageSize: number): Page<T> =>
    pageOf(pageParam ? searchParams.get(pageParam) : null, items, pageSize);

  return { get, set, page };
}

/**
 * A search box's value, held in local state and seeded from the URL once.
 *
 * The URL write lands a render later, and an input bound straight to it drops
 * keystrokes, so the input reads this copy instead. A blank search leaves its
 * param out and starts the list on page 1.
 */
export function useSearchParamInput(key: string, pageParam?: string) {
  const { get, set } = useListParams(pageParam);
  const [value, setValue] = useState(() => get(key) ?? "");

  const onValueChange = (next: string) => {
    setValue(next);
    set(key, next.trim() || null);
  };

  return { value, onValueChange };
}
