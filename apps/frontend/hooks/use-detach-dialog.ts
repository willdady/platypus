import { useState } from "react";

/**
 * The Shared-resource detach dialog's state (#598): which org-scoped item is
 * selected, and the error from a failed detach — always opened and cleared
 * together, so they're one piece of state rather than two kept in sync by
 * hand. The lists reach it through `useSharedDetach`, which adds the detach
 * write itself (#880); this stays the state half on its own.
 */
export function useDetachDialog<T>() {
  const [selected, setSelected] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = (item: T) => {
    setError(null);
    setSelected(item);
  };

  const close = () => {
    setSelected(null);
    setError(null);
  };

  return { selected, error, setError, open, close };
}
