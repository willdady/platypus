import { EventEmitter } from "node:events";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Two instances share one Postgres. The pool here stands in for it: a
 * `pg_notify` sent through `query` reaches every connection that LISTENed.
 */
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

const { cancelRun, listenForRunCancels } = await import("./run-cancel.ts");
const { runRegistry } = await import("./run-registry.ts");

/** A pooled connection: an emitter that can run `LISTEN`. */
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

  it("broadcasts a run this instance does not hold", async () => {
    await cancelRun("chat-1");

    expect(pool.query).toHaveBeenCalledWith("SELECT pg_notify($1, $2)", [
      "run_cancel",
      "chat-1",
    ]);
  });
});

describe("listenForRunCancels", () => {
  it("aborts a run held here when another instance cancels it", async () => {
    const client = fakeClient();
    pool.connect.mockResolvedValueOnce(client);
    listenForRunCancels();
    await vi.waitFor(() =>
      expect(client.query).toHaveBeenCalledWith("LISTEN run_cancel"),
    );
    listeners.push(client);
    const handle = runRegistry.register("chat-1");

    // What the other instance's cancel route sends, having no run to abort.
    await pool.query("SELECT pg_notify($1, $2)", ["run_cancel", "chat-1"]);

    expect(handle.signal.aborted).toBe(true);
  });

  // A dropped LISTEN connection would otherwise leave this instance deaf to
  // every cancel sent from another one.
  it("reconnects when its connection drops", async () => {
    vi.useFakeTimers();
    const first = fakeClient();
    const second = fakeClient();
    pool.connect.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    listenForRunCancels();
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
