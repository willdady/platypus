"use client";

import { useEffect, useRef } from "react";
import { documentTitle } from "@/lib/page-title";

/**
 * Titles the tab after an entity the browser has read, for a page whose name
 * changes while it is open (a Chat is titled after its first turn), so a title
 * resolved once on the server would go stale.
 *
 * The route's metadata title stands until `name` is known, and is put back
 * when the name goes away or the hook unmounts. A soft navigation to a route
 * with the same metadata title leaves React nothing to update, so without
 * this the previous entity's name would stay in the tab. A title something
 * else set since is left alone.
 */
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

/** The route's metadata title, and the one this hook last set over it. */
type Titles = { route: string | null; own: string | null };

function restoreRouteTitle(titles: Titles) {
  if (titles.route !== null && document.title === titles.own) {
    document.title = titles.route;
  }
  titles.own = null;
}
