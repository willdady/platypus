import { useState } from "react";

/**
 * Re-initialises local state whenever `key` changes, using React's documented
 * "adjust state during render" pattern instead of a `setState`-in-effect.
 *
 * `reset` is invoked synchronously during render (only when `key` differs from
 * the previous render), so React discards the in-progress render and restarts
 * with the new state — no cascading effect-triggered re-render. Use this for
 * editable fields that should track a server/prop value until the user edits
 * them, then re-sync when that value changes.
 *
 * @param key   A primitive (or identity-stable) value that changes when the
 *              synced source changes — e.g. `widget.title` or
 *              `String(widget.updatedAt)`.
 * @param reset Applies the latest source values to local state.
 */
export function useResetOnChange(key: unknown, reset: () => void) {
  const [prevKey, setPrevKey] = useState(key);
  if (key !== prevKey) {
    setPrevKey(key);
    reset();
  }
}
