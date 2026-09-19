import { useState } from "react";

const sameIds = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const id of a) {
    if (!b.has(id)) return false;
  }
  return true;
};

/**
 * Keeps the identity of the previous set whenever the next one holds the same
 * ids, using React's documented "adjust state during render" pattern.
 *
 * A derived Set is rebuilt on every render; the Transcript memo compares
 * `staleToolCallIds` by identity, so without this every streamed token handed
 * every message a fresh Set and re-rendered the whole transcript — the case
 * where Tool-result clearing is actually active (issue #869). Equal contents
 * are the common case: a streamed token changes text, not tool results.
 */
export const useStableSet = (
  next: ReadonlySet<string>,
): ReadonlySet<string> => {
  const [held, setHeld] = useState(next);
  if (!sameIds(held, next)) {
    setHeld(next);
  }
  return held;
};
