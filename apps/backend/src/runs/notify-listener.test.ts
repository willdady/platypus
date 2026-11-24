import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { pool } = vi.hoisted(() => ({
  pool: { connect: vi.fn() },
}));

vi.mock("../index.ts", () => ({ db: { $client: pool } }));

import {
  HEARTBEAT_MS,
  HEARTBEAT_TIMEOUT_MS,
  RECONNECT_MS,
  onNotification,
  startNotificationListener,
} from "./notify-listener.ts";

const fakeClient = () => ({
  on: vi.fn(),
  query: vi.fn().mockResolvedValue({ rows: [] }),
  release: vi.fn(),
});

const neverAnswersHeartbeat = () => {
  const client = fakeClient();
  client.query.mockImplementation((sql: string) =>
    sql === "SELECT 1" ? new Promise(() => {}) : Promise.resolve({ rows: [] }),
  );
  return client;
};

beforeEach(() => {
  vi.clearAllMocks();
  pool.connect.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startNotificationListener", () => {
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

describe("the notification listener heartbeat", () => {
  it("reconnects and re-listens when a heartbeat never settles", async () => {
    vi.useFakeTimers();
    onNotification("heartbeat_dead", () => {});
    const dead = neverAnswersHeartbeat();
    const revived = fakeClient();
    pool.connect.mockResolvedValueOnce(dead).mockResolvedValueOnce(revived);

    const stop = startNotificationListener();
    await vi.advanceTimersByTimeAsync(0);
    expect(dead.query).toHaveBeenCalledWith("LISTEN heartbeat_dead");
    expect(revived.query).not.toHaveBeenCalledWith("LISTEN heartbeat_dead");

    await vi.advanceTimersByTimeAsync(
      HEARTBEAT_MS + HEARTBEAT_TIMEOUT_MS + RECONNECT_MS,
    );

    expect(dead.release).toHaveBeenCalled();
    expect(revived.query).toHaveBeenCalledWith("LISTEN heartbeat_dead");
    stop();
  });

  it("stays connected when heartbeats keep succeeding", async () => {
    vi.useFakeTimers();
    const client = fakeClient();
    pool.connect.mockResolvedValue(client);

    const stop = startNotificationListener();
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3 + RECONNECT_MS);

    expect(client.query).toHaveBeenCalledWith("SELECT 1");
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(client.release).not.toHaveBeenCalled();
    stop();
  });

  it("stops the heartbeat when the listener stops", async () => {
    vi.useFakeTimers();
    const client = neverAnswersHeartbeat();
    pool.connect.mockResolvedValue(client);

    const stop = startNotificationListener();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(client.query).toHaveBeenCalledWith("SELECT 1");

    stop();
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(
      client.query.mock.calls.filter(([sql]) => sql === "SELECT 1"),
    ).toHaveLength(1);
  });
});
