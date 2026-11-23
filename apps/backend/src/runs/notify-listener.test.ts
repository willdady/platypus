import { describe, it, expect, vi, beforeEach } from "vitest";

const { pool } = vi.hoisted(() => ({
  pool: { connect: vi.fn() },
}));

vi.mock("../index.ts", () => ({ db: { $client: pool } }));

import {
  onNotification,
  startNotificationListener,
} from "./notify-listener.ts";

const fakeClient = () => ({
  on: vi.fn(),
  query: vi.fn().mockResolvedValue({ rows: [] }),
  release: vi.fn(),
});

describe("startNotificationListener", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pool.connect.mockReset();
  });

  it("returns a stop handle that releases the LISTEN client", async () => {
    const client = fakeClient();
    pool.connect.mockResolvedValue(client);

    const stop = startNotificationListener();
    await vi.waitFor(() => expect(pool.connect).toHaveBeenCalled());
    expect(client.release).not.toHaveBeenCalled();

    stop();

    expect(client.release).toHaveBeenCalled();
  });

  it("releases the client and stays down after a connection error once stopped", async () => {
    vi.useFakeTimers();
    const client = fakeClient();
    pool.connect.mockResolvedValueOnce(client);

    const stop = startNotificationListener();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(pool.connect).toHaveBeenCalled());

    stop();
    const errorHandler = client.on.mock.calls.find(
      ([event]) => event === "error",
    )?.[1] as ((err: unknown) => void) | undefined;
    errorHandler?.(new Error("socket hang up"));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(pool.connect).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("hands notifications to the registered handler until stopped", async () => {
    const handler = vi.fn();
    onNotification("chat_run_cancel", handler);
    const client = fakeClient();
    pool.connect.mockResolvedValue(client);

    const stop = startNotificationListener();
    await vi.waitFor(() => expect(pool.connect).toHaveBeenCalled());

    expect(client.on).toHaveBeenCalledWith(
      "notification",
      expect.any(Function),
    );
    stop();
  });
});
