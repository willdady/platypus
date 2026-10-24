import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetMockDb, seedDb } from "../test-utils.ts";

vi.mock("../storage/utils.ts", () => ({
  extractFiles: vi.fn((messages: unknown[]) => Promise.resolve(messages)),
}));

import { logger } from "../logger.ts";
import {
  drainRuns,
  installCrashHandlers,
  installShutdownHandlers,
} from "./shutdown.ts";
import { startRun } from "./run-lifecycle.ts";
import { runRegistry } from "./run-registry.ts";
import { ChatSink } from "./sinks/chat-sink.ts";
import type { RunStatus } from "./types.ts";

/** A Chat whose turn this process is running, through its real sink. */
const startChatRun = async () => {
  const fake = seedDb({
    workspace: [{ id: "ws-1", ownerId: "owner-1" }],
    chat: [
      {
        id: "chat-1",
        workspaceId: "ws-1",
        title: "Chat",
        status: "succeeded",
        activeLeafId: null,
      },
    ],
    chat_message: [],
  });
  const sink = new ChatSink({
    orgId: "org-1",
    workspaceId: "ws-1",
    ownerId: "owner-1",
    parentId: null,
    message: { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
  });
  await sink.onStart({ runId: "chat-1", messages: [] });
  startRun({
    runId: "chat-1",
    onTerminate: ({ status }) =>
      sink.onFinish({ runId: "chat-1", status, messages: [], stats: {} }),
  });
  return fake;
};

describe("drainRuns", () => {
  beforeEach(() => {
    runRegistry.resetStopStateForTests();
  });

  afterEach(() => {
    for (const { runId } of runRegistry.heldRuns()) runRegistry.cancel(runId);
    vi.useRealTimers();
  });

  it("cancels every held run and waits for each to write its end", async () => {
    const ended: RunStatus[] = [];
    for (const runId of ["run-a", "run-b"]) {
      startRun({
        runId,
        onTerminate: async ({ status }) => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          ended.push(status);
        },
      });
    }

    expect(await drainRuns(1_000)).toBe(true);

    expect(ended).toEqual(["cancelled", "cancelled"]);
    expect(runRegistry.has("run-a")).toBe(false);
    expect(runRegistry.has("run-b")).toBe(false);
  });

  it("gives up after its bound on a run that never ends", async () => {
    vi.useFakeTimers();
    startRun({ runId: "stuck", onTerminate: () => new Promise(() => {}) });

    const drained = drainRuns(8_000);
    await vi.advanceTimersByTimeAsync(8_000);

    expect(await drained).toBe(false);
    runRegistry.unregister("stuck");
  });

  it("resolves at once with nothing held", async () => {
    expect(await drainRuns(1_000)).toBe(true);
  });
});

describe("installShutdownHandlers", () => {
  let uninstall = () => {};

  beforeEach(() => {
    resetMockDb();
    // A drain's stopping gate is terminal in production; reopen it between
    // tests so the next one can register runs again.
    runRegistry.resetStopStateForTests();
  });

  afterEach(() => {
    uninstall();
    for (const { runId } of runRegistry.heldRuns()) runRegistry.cancel(runId);
    vi.useRealTimers();
  });

  it.each(["SIGTERM", "SIGINT"] as const)(
    "on %s, ends the held Chat run as cancelled before exiting",
    async (signal) => {
      const fake = await startChatRun();
      expect(fake.tables.chat[0].status).toBe("running");
      const order: string[] = [];
      const exit = vi.fn((code: number) => {
        order.push(`exit ${code}`);
        // What the process looks like the moment it exits.
        order.push(`chat ${String(fake.tables.chat[0].status)}`);
      });
      uninstall = installShutdownHandlers({
        stopAccepting: () => order.push("stop accepting"),
        exit,
        timeoutMs: 1_000,
      });

      process.emit(signal, signal);
      await vi.waitFor(() => expect(exit).toHaveBeenCalled());

      expect(order).toEqual(["stop accepting", "exit 0", "chat cancelled"]);
    },
  );

  it("ignores a second signal while draining", async () => {
    await startChatRun();
    const exit = vi.fn();
    const stopAccepting = vi.fn();
    uninstall = installShutdownHandlers({ stopAccepting, exit });

    process.emit("SIGTERM", "SIGTERM");
    process.emit("SIGTERM", "SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    expect(stopAccepting).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("stops background work, drains runs, then closes server and pool in order", async () => {
    const ended: RunStatus[] = [];
    for (const runId of ["run-a", "run-b"]) {
      startRun({
        runId,
        onTerminate: async ({ status }) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          ended.push(status);
        },
      });
    }

    const order: string[] = [];
    const exit = vi.fn((code: number) => order.push(`exit ${code}`));
    uninstall = installShutdownHandlers({
      // The scheduler ticks, notification listener and A2A cancel watcher.
      stopBackground: () => order.push("stop background"),
      // The HTTP listener.
      stopAccepting: () => order.push("stop accepting"),
      // Idle keep-alive + SSE connections, so `close` is not held by them.
      closeIdleConnections: () => order.push("close idle connections"),
      // Awaiting the HTTP server's in-flight requests.
      close: () => {
        order.push("close");
        return Promise.resolve();
      },
      // The Postgres pool, last: everything that needs the db has ended.
      endPool: () => {
        order.push("end pool");
        return Promise.resolve();
      },
      exit,
      timeoutMs: 2_000,
    });

    process.emit("SIGTERM", "SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    expect(order).toEqual([
      "stop background",
      "stop accepting",
      "close idle connections",
      "close",
      "end pool",
      "exit 0",
    ]);
    // The runs were ended as cancelled before anything was closed.
    expect(ended).toEqual(["cancelled", "cancelled"]);
  });

  it("refuses new runs once the drain has started (503, not a new run)", async () => {
    startRun({
      runId: "held",
      onTerminate: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      },
    });
    const exit = vi.fn();
    uninstall = installShutdownHandlers({ exit, timeoutMs: 2_000 });

    process.emit("SIGTERM", "SIGTERM");
    // A registration racing the drain — a cron tick already in flight — is
    // refused rather than started and then killed by the exit.
    expect(() => startRun({ runId: "late", onTerminate: () => {} })).toThrow(
      "Server is shutting down",
    );

    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    expect(exit).toHaveBeenCalledWith(0);
    expect(runRegistry.has("late")).toBe(false);
    expect(runRegistry.has("held")).toBe(false);
  });

  it("exits 1 when the drain times out on a run that never ends", async () => {
    vi.useFakeTimers();
    startRun({ runId: "stuck", onTerminate: () => new Promise(() => {}) });
    const exit = vi.fn();
    const endPool = vi.fn(() => Promise.resolve());
    uninstall = installShutdownHandlers({ exit, endPool, timeoutMs: 8_000 });

    process.emit("SIGTERM", "SIGTERM");
    await vi.advanceTimersByTimeAsync(8_000);

    expect(exit).toHaveBeenCalledWith(1);
    // The budget was spent waiting for the run; the pool is not reached.
    expect(endPool).not.toHaveBeenCalled();
    runRegistry.unregister("stuck");
  });

  it("still ends the pool when the drain is stopped by a timeout, if budget remains", async () => {
    vi.useFakeTimers();
    const close = vi.fn(
      () => new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    );
    const endPool = vi.fn(() => Promise.resolve());
    const exit = vi.fn();
    uninstall = installShutdownHandlers({
      close,
      endPool,
      exit,
      timeoutMs: 4_000,
    });

    process.emit("SIGTERM", "SIGTERM");
    // Nothing held: whenIdle resolves at once. `close` spends 2s, leaving
    // enough for `endPool` inside the same 4s budget.
    await vi.advanceTimersByTimeAsync(4_000);

    expect(close).toHaveBeenCalledTimes(1);
    expect(endPool).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe("installCrashHandlers", () => {
  let uninstall = () => {};

  beforeEach(() => {
    runRegistry.resetStopStateForTests();
  });

  afterEach(() => {
    uninstall();
    for (const { runId } of runRegistry.heldRuns()) runRegistry.cancel(runId);
    vi.useRealTimers();
  });

  it("logs a rejection fatal, drains the held runs, and exits 1", async () => {
    const ended: RunStatus[] = [];
    for (const runId of ["crash-a"]) {
      startRun({
        runId,
        onTerminate: async ({ status }) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          ended.push(status);
        },
      });
    }
    const exit = vi.fn();
    const fatal = vi.spyOn(logger, "fatal").mockImplementation(() => undefined);
    uninstall = installCrashHandlers({ exit, timeoutMs: 1_000 });

    process.emit("unhandledRejection", new Error("boom"));
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    expect(fatal).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
    expect(ended).toEqual(["cancelled"]);
    fatal.mockRestore();
  });

  it("ignores a second crash while the first one drains", async () => {
    vi.useFakeTimers();
    startRun({ runId: "stuck", onTerminate: () => new Promise(() => {}) });
    const exit = vi.fn();
    uninstall = installCrashHandlers({ exit, timeoutMs: 8_000 });

    process.emit("uncaughtException", new Error("boom1"));
    process.emit("uncaughtException", new Error("boom2"));
    await vi.advanceTimersByTimeAsync(8_000);

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    runRegistry.unregister("stuck");
  });
});
