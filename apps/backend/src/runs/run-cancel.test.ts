import { EventEmitter } from "node:events";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockLogger } from "../test-setup.ts";

const { pool, listeners } = vi.hoisted(() => {
  const listeners: EventEmitter[] = [];
  const pool = {
    query: vi.fn((_text: string, [channel, payload]: string[]) => {
      for (const client of listeners) {
        client.emit("notification", { channel, payload });
      }
      return Promise.resolve({ rows: [] });
    }),
    connect: vi.fn(),
  };
  return { pool, listeners };
});
vi.mock("../index.ts", () => ({ db: { $client: pool } }));

const { cancelRun } = await import("./run-cancel.ts");
const { startNotificationListener } = await import("./notify-listener.ts");
const { runRegistry } = await import("./run-registry.ts");

const fakeClient = () =>
  Object.assign(new EventEmitter(), {
    query: vi.fn(() => Promise.resolve()),
    release: vi.fn(),
  });

beforeEach(() => {
  vi.clearAllMocks();
  listeners.length = 0;
});
afterEach(() => {
  runRegistry.unregister("chat-1");
  vi.useRealTimers();
});

describe("cancelRun", () => {
  it("aborts a run this instance holds without broadcasting", async () => {
    const handle = runRegistry.register("chat-1");

    await cancelRun("chat-1");

    expect(handle.signal.aborted).toBe(true);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("broadcasts a run this instance does not hold, as JSON", async () => {
    await cancelRun("chat-1");

    expect(pool.query).toHaveBeenCalledWith("SELECT pg_notify($1, $2)", [
      "run_cancel",
      JSON.stringify({ runId: "chat-1" }),
    ]);
  });
});

describe("cancelRun for a turn", () => {
  it("aborts a run held here for that turn, without broadcasting", async () => {
    const handle = runRegistry.register("chat-1", { turnId: "msg-a" });

    await cancelRun("chat-1", { turnId: "msg-a" });

    expect(handle.signal.aborted).toBe(true);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("spares a run held here for another turn, and tells the other instances", async () => {
    const handle = runRegistry.register("chat-1", { turnId: "msg-b" });

    await cancelRun("chat-1", { turnId: "msg-a" });

    expect(handle.signal.aborted).toBe(false);
    expect(pool.query).toHaveBeenCalledWith("SELECT pg_notify($1, $2)", [
      "run_cancel",
      JSON.stringify({ runId: "chat-1", turnId: "msg-a" }),
    ]);
  });
});

describe("the notification listener", () => {
  it("aborts a run held here when another instance cancels it", async () => {
    const client = fakeClient();
    pool.connect.mockResolvedValueOnce(client);
    startNotificationListener();
    await vi.waitFor(() =>
      expect(client.query).toHaveBeenCalledWith("LISTEN run_cancel"),
    );
    listeners.push(client);
    const handle = runRegistry.register("chat-1");

    await pool.query("SELECT pg_notify($1, $2)", [
      "run_cancel",
      JSON.stringify({ runId: "chat-1" }),
    ]);

    expect(handle.signal.aborted).toBe(true);
  });

  it("ignores a payload that is not a cancel as cancelRun sends it", async () => {
    const client = fakeClient();
    pool.connect.mockResolvedValueOnce(client);
    startNotificationListener();
    await vi.waitFor(() =>
      expect(client.query).toHaveBeenCalledWith("LISTEN run_cancel"),
    );
    listeners.push(client);
    const handle = runRegistry.register("chat-1");

    for (const payload of ["chat-1", "{not json", "{}", "null"]) {
      await pool.query("SELECT pg_notify($1, $2)", ["run_cancel", payload]);
    }

    expect(handle.signal.aborted).toBe(false);
  });

  it("logs and drops a payload it does not understand, never throwing on the listener", async () => {
    const client = fakeClient();
    pool.connect.mockResolvedValueOnce(client);
    startNotificationListener();
    await vi.waitFor(() =>
      expect(client.query).toHaveBeenCalledWith("LISTEN run_cancel"),
    );
    listeners.push(client);

    await pool.query("SELECT pg_notify($1, $2)", [
      "run_cancel",
      JSON.stringify({ runId: "chat-1", unexpected: true }),
    ]);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.any(String) as unknown }),
      expect.stringContaining("run_cancel"),
    );
  });

  it("aborts a run held here when another instance cancels its turn", async () => {
    const client = fakeClient();
    pool.connect.mockResolvedValueOnce(client);
    startNotificationListener();
    await vi.waitFor(() =>
      expect(client.query).toHaveBeenCalledWith("LISTEN run_cancel"),
    );
    listeners.push(client);
    const handle = runRegistry.register("chat-1", { turnId: "msg-a" });

    await pool.query("SELECT pg_notify($1, $2)", [
      "run_cancel",
      JSON.stringify({ runId: "chat-1", turnId: "msg-a" }),
    ]);

    expect(handle.signal.aborted).toBe(true);
  });

  it("spares a run held here for another turn another instance cancels", async () => {
    const client = fakeClient();
    pool.connect.mockResolvedValueOnce(client);
    startNotificationListener();
    await vi.waitFor(() =>
      expect(client.query).toHaveBeenCalledWith("LISTEN run_cancel"),
    );
    listeners.push(client);
    const handle = runRegistry.register("chat-1", { turnId: "msg-b" });

    await pool.query("SELECT pg_notify($1, $2)", [
      "run_cancel",
      JSON.stringify({ runId: "chat-1", turnId: "msg-a" }),
    ]);

    expect(handle.signal.aborted).toBe(false);
  });

  it("reconnects when its connection drops", async () => {
    vi.useFakeTimers();
    const first = fakeClient();
    const second = fakeClient();
    pool.connect.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    startNotificationListener();
    await vi.waitFor(() => expect(first.query).toHaveBeenCalled());

    const lost = new Error("connection terminated");
    first.emit("error", lost);
    expect(first.release).toHaveBeenCalledWith(lost);
    await vi.runOnlyPendingTimersAsync();

    await vi.waitFor(() =>
      expect(second.query).toHaveBeenCalledWith("LISTEN run_cancel"),
    );
  });
});
