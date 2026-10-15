import * as React from "react";

/**
 * Whether `query` matches, kept current as it changes. False on the server.
 *
 * `subscribe` and `getSnapshot` are memoised on `query`: React compares them
 * by reference, and a fresh `subscribe` each render would tear down and
 * re-attach the `matchMedia` listener on every render.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = React.useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query],
  );
  const getSnapshot = React.useCallback(
    () => window.matchMedia(query).matches,
    [query],
  );
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

const getServerSnapshot = () => false;
