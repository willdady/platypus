"use client";

import { useEffect } from "react";
import { documentTitle } from "@/lib/page-title";

/**
 * Titles the tab after an entity the browser has read, for a page whose name
 * changes while it is open (a Chat is titled after its first turn), so a title
 * resolved once on the server would go stale.
 *
 * The route's metadata title stands until `name` is known. It is not restored
 * on unmount: the next route's metadata sets its own.
 */
export function useDocumentTitle(
  name: string | null | undefined,
  scopeName: string | null | undefined,
): void {
  useEffect(() => {
    if (!name?.trim()) return;
    document.title = documentTitle(name, scopeName);
  }, [name, scopeName]);
}
