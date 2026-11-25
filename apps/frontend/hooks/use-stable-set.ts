import { useState } from "react";

function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const id of a) {
    if (!b.has(id)) return false;
  }
  return true;
}

export function useStableSet(next: ReadonlySet<string>): ReadonlySet<string> {
  const [held, setHeld] = useState(next);
  if (!sameIds(held, next)) {
    setHeld(next);
  }
  return held;
}
