import * as React from "react";

const MOBILE_BREAKPOINT = 768;

export function useIsMobile() {
  // useSyncExternalStore subscribes to the media query and snapshots the
  // current match, avoiding a setState-in-effect while staying SSR-safe
  // (the server snapshot is `false`).
  return React.useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.innerWidth < MOBILE_BREAKPOINT,
    () => false,
  );
}
