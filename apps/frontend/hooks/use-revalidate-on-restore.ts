import { useEffect, useRef } from "react";

/**
 * Shortest gap between two revalidations this hook will trigger. Long enough
 * that a browser firing a restore alongside its own focus event — which SWR
 * revalidates on separately — collapses into one request.
 */
export const RESTORE_THROTTLE_MS = 3_000;

/**
 * Revalidates a read when the page comes back from the back/forward cache.
 *
 * SWR revalidates on focus and on reconnect, which covers `visibilitychange`,
 * `focus` and `online`. A bfcache restore is none of those, and it is the case
 * that most needs it: a frozen page's timers do not run at all while it is
 * away, so a correctly-armed poll has not been polling and the row on screen is
 * as old as the moment the page was put away.
 *
 * Only an actual restore is acted on. An ordinary navigation fires `pageshow`
 * too, with `persisted` false, and that page already revalidates on mount.
 */
export function useRevalidateOnRestore(revalidate: () => void) {
  const revalidateRef = useRef(revalidate);
  useEffect(() => {
    revalidateRef.current = revalidate;
  }, [revalidate]);

  useEffect(() => {
    let lastAt = 0;
    const onPageShow = (event: Event) => {
      if (!(event as PageTransitionEvent).persisted) return;
      const now = Date.now();
      if (now - lastAt < RESTORE_THROTTLE_MS) return;
      lastAt = now;
      revalidateRef.current();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);
}
