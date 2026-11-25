"use client";

import { useEffect, useRef } from "react";
import { documentTitle } from "@/lib/page-title";

export function useDocumentTitle(
  name: string | null | undefined,
  scopeName: string | null | undefined,
): void {
  const titles = useRef<Titles>({ route: null, own: null });

  useEffect(() => {
    if (!name?.trim()) {
      restoreRouteTitle(titles.current);
      return;
    }
    titles.current.route ??= document.title;
    titles.current.own = documentTitle(name, scopeName);
    document.title = titles.current.own;
  }, [name, scopeName]);

  useEffect(() => {
    const current = titles.current;
    return () => restoreRouteTitle(current);
  }, []);
}

type Titles = { route: string | null; own: string | null };

function restoreRouteTitle(titles: Titles) {
  if (titles.route !== null && document.title === titles.own) {
    document.title = titles.route;
  }
  titles.own = null;
}
