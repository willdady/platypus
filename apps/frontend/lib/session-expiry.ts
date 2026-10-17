import { errorStatus } from "@/lib/utils";

/**
 * How long after one 401 further 401s are taken as the same expiry. Every
 * read in flight when the session ends fails together; one re-read answers
 * them all.
 */
export const SESSION_EXPIRY_WINDOW_MS = 5_000;

/**
 * SWR's global `onError`: a 401 means the session ended mid-page, so it
 * re-reads the session — once per burst — and `ProtectedRoute` then sends the
 * reader to sign in. A read that is expected to 401 opts out with its own
 * `onError`.
 */
export function sessionExpiryHandler(refetch: () => unknown) {
  let lastRefetch = -Infinity;
  return (error: unknown) => {
    if (errorStatus(error) !== 401) return;
    const now = Date.now();
    if (now - lastRefetch < SESSION_EXPIRY_WINDOW_MS) return;
    lastRefetch = now;
    void refetch();
  };
}
