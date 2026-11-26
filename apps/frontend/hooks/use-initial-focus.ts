import { useEffect, useRef } from "react";

export function useInitialFocus<T extends HTMLElement>(when: boolean = true) {
  const ref = useRef<T>(null);

  useEffect(() => {
    if (when) ref.current?.focus();
  }, [when]);

  return ref;
}
