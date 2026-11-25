import { useCallback, useEffect, useRef } from "react";

export function useTimeout(): (fn: () => void, ms: number) => void {
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return useCallback((fn: () => void, ms: number) => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(fn, ms);
  }, []);
}
