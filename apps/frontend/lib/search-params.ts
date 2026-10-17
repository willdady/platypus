/**
 * Sets one query-string param, or removes it for `null`/empty, without a new
 * history entry.
 *
 * `history.replaceState` rather than `router.replace`: Next keeps
 * `useSearchParams` in step with it, with no server round-trip. A relative
 * `?…` URL keeps the path, base path included. Pass `null`, not
 * `history.state`: Next copies its own state across, and skips the sync
 * entirely for state already carrying its `__NA` marker.
 */
export function replaceSearchParam(key: string, value: string | null) {
  const params = new URLSearchParams(window.location.search);
  if (value) {
    params.set(key, value);
  } else {
    params.delete(key);
  }
  const qs = params.toString();
  window.history.replaceState(
    null,
    "",
    qs ? `?${qs}` : window.location.pathname,
  );
}
