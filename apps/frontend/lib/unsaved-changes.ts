import { stripBasePath } from "@/lib/routes";

/**
 * The in-app path a click would navigate to, or null when the click is one
 * the unsaved-changes guard lets through: a modified or non-primary click, a
 * link that opens elsewhere (`target`, `download`, another origin or outside
 * the base path), or a `#` anchor on the current page.
 */
export function interceptedHref(event: MouseEvent): string | null {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    !(event.target instanceof Element)
  ) {
    return null;
  }
  const anchor = event.target.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) return null;
  if (
    (anchor.target && anchor.target !== "_self") ||
    anchor.hasAttribute("download")
  ) {
    return null;
  }

  const url = new URL(anchor.href);
  const here = window.location;
  if (url.origin !== here.origin) return null;
  if (url.hash && url.pathname === here.pathname && url.search === here.search)
    return null;

  // `router.push` adds the base path back, so strip the one the href carries.
  const path = stripBasePath(url.pathname);
  return path === null ? null : `${path}${url.search}${url.hash}`;
}
