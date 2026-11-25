import { errorStatus } from "@/lib/utils";

export const SESSION_EXPIRY_WINDOW_MS = 5_000;

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
