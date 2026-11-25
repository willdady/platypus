import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { pageOf, type Page } from "@/components/list-pagination";
import { replaceSearchParam } from "@/lib/search-params";

export function useListParams(pageParam?: string) {
  const searchParams = useSearchParams();

  const get = (key: string) => searchParams.get(key);

  const set = (key: string, value: string | null) => {
    replaceSearchParam(key, value);
    if (pageParam) replaceSearchParam(pageParam, null);
  };

  const page = <T>(items: readonly T[], pageSize: number): Page<T> =>
    pageOf(pageParam ? searchParams.get(pageParam) : null, items, pageSize);

  return { get, set, page };
}

export function useSearchParamInput(key: string, pageParam?: string) {
  const { get, set } = useListParams(pageParam);
  // why: the URL write lands a render later, so an input bound to it drops keystrokes
  const [value, setValue] = useState(() => get(key) ?? "");

  const onValueChange = (next: string) => {
    setValue(next);
    set(key, next.trim() || null);
  };

  return { value, onValueChange };
}
