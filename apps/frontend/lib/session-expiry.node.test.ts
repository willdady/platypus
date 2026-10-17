import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_EXPIRY_WINDOW_MS,
  sessionExpiryHandler,
} from "./session-expiry";

function failed(status: number) {
  return Object.assign(new Error(), { status });
}

describe("sessionExpiryHandler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("re-reads the session once for a burst of 401s", () => {
    const refetch = vi.fn();
    const onError = sessionExpiryHandler(refetch);

    onError(failed(401));
    onError(failed(401));
    vi.advanceTimersByTime(SESSION_EXPIRY_WINDOW_MS - 1);
    onError(failed(401));

    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("re-reads it again for a 401 after the burst", () => {
    const refetch = vi.fn();
    const onError = sessionExpiryHandler(refetch);

    onError(failed(401));
    vi.advanceTimersByTime(SESSION_EXPIRY_WINDOW_MS);
    onError(failed(401));

    expect(refetch).toHaveBeenCalledTimes(2);
  });

  it("leaves any other failure alone", () => {
    const refetch = vi.fn();
    const onError = sessionExpiryHandler(refetch);

    onError(failed(403));
    onError(failed(500));
    onError(new Error("network"));

    expect(refetch).not.toHaveBeenCalled();
  });
});
