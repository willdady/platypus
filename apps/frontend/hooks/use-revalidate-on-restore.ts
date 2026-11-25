import { useEffect, useRef } from "react";

export const RESTORE_THROTTLE_MS = 3_000;

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
