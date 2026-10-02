import { useCallback, useEffect, useRef } from "react";

/**
 * A `setTimeout` owned by the component: scheduling again replaces the pending
 * timer, and unmounting drops it, so rapid clicks never overlap and nothing
 * fires into an unmounted component.
 */
export const useTimeout = (): ((fn: () => void, ms: number) => void) => {
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return useCallback((fn: () => void, ms: number) => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(fn, ms);
  }, []);
};
