import { useState } from "react";

// Sentinel that no real key can ever equal, so the very first render always
// counts as a "change" and fires `reset`. Seeding `prevKey` with the first
// render's key instead (the old behaviour) meant that when the synced source
// was already available synchronously — e.g. served from SWR's warm in-memory
// cache after client-side navigation — the key never subsequently changed and
// `reset` never ran, leaving the form on its empty defaults (#332).
const UNINITIALIZED = Symbol("useResetOnChange:uninitialized");

/**
 * Re-initialises local state whenever `key` changes, using React's documented
 * "adjust state during render" pattern instead of a `setState`-in-effect.
 *
 * `reset` is invoked synchronously during render — on the first render and
 * whenever `key` differs from the previous render — so React discards the
 * in-progress render and restarts with the new state, with no cascading
 * effect-triggered re-render. Use this for editable fields that should track a
 * server/prop value until the user edits them, then re-sync when that value
 * changes.
 *
 * Because it also runs on the first render, `reset` fires whether the source
 * is present synchronously (warm cache) or arrives later (cold load). Guard the
 * callback against a not-yet-loaded source (`if (source) { … }`) so the initial
 * run is a harmless no-op when there is nothing to sync yet.
 *
 * @param key   A primitive (or identity-stable) value that changes when the
 *              synced source changes — e.g. `widget.title` or
 *              `String(widget.updatedAt)`.
 * @param reset Applies the latest source values to local state.
 */
export function useResetOnChange(key: unknown, reset: () => void) {
  const [prevKey, setPrevKey] = useState<unknown>(UNINITIALIZED);
  if (key !== prevKey) {
    setPrevKey(key);
    reset();
  }
}
