import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetMockDb, seedDb } from "../test-utils.ts";
import { logger } from "../logger.ts";

vi.mock("../storage/utils.ts", () => ({
  extractFiles: vi.fn((messages: unknown[]) => Promise.resolve(messages)),
}));

import { drainRuns, installShutdownHandlers } from "./shutdown.ts";
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

/** A server whose connections close when told, recording each call. */
const fakeServer = (order: string[]) => ({
  close: vi.fn((done?: (err?: Error) => void) => {
    order.push("stop listening");
    // The open connections close once the runs behind them have ended.
    void runRegistry.whenIdle(60_000).then(() => done?.());
    return undefined as never;
  }),
  closeIdleConnections: vi.fn(() => {
    order.push("close idle connections");
  }),
  closeAllConnections: vi.fn(() => {
    order.push("cut connections");
  }),
});

describe("installShutdownHandlers", () => {
  let uninstall = () => {};

  beforeEach(() => {
    resetMockDb();
  });

  afterEach(() => {
    uninstall();
    runRegistry.stopping = false;
    vi.useRealTimers();
  });

  it.each(["SIGTERM", "SIGINT"] as const)(
    "on %s, stops new work, ends the held Chat run, then closes connections and the pool",
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
        stopBackground: () => {
          order.push(`stop background, stopping ${runRegistry.stopping}`);
        },
        server: fakeServer(order),
        closePool: () => {
          order.push(`end pool, runs held ${runRegistry.heldRuns().length}`);
          return Promise.resolve();
        },
        exit,
        timeoutMs: 1_000,
      });

      process.emit(signal, signal);
      await vi.waitFor(() => expect(exit).toHaveBeenCalled());

      expect(order).toEqual([
        "stop background, stopping true",
        "close idle connections",
        "stop listening",
        "end pool, runs held 0",
        "exit 0",
        "chat cancelled",
      ]);
    },
  );

  it("refuses a run started while draining", async () => {
    await startChatRun();
    const exit = vi.fn();
    uninstall = installShutdownHandlers({ exit, timeoutMs: 1_000 });

    process.emit("SIGTERM", "SIGTERM");

    expect(() => startRun({ runId: "late", onTerminate: () => {} })).toThrow(
      /shutting down/,
    );
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it("exits 1, having cut the connections, when the drain runs out", async () => {
    vi.useFakeTimers();
    startRun({ runId: "stuck", onTerminate: () => new Promise(() => {}) });
    const order: string[] = [];
    const exit = vi.fn();
    uninstall = installShutdownHandlers({
      server: fakeServer(order),
      closePool: () => Promise.resolve(),
      exit,
      timeoutMs: 8_000,
    });

    process.emit("SIGTERM", "SIGTERM");
    await vi.advanceTimersByTimeAsync(8_100);

    expect(exit).toHaveBeenCalledWith(1);
    expect(order).toContain("cut connections");
    runRegistry.unregister("stuck");
  });

  it("on an unhandled rejection, logs fatal, drains and exits 1", async () => {
    const fake = await startChatRun();
    const exit = vi.fn();
    uninstall = installShutdownHandlers({ exit, crashTimeoutMs: 1_000 });

    process.emit(
      "unhandledRejection",
      new Error("plugin timer"),
      Promise.resolve(),
    );
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    expect(exit).toHaveBeenCalledWith(1);
    expect(fake.tables.chat[0].status).toBe("cancelled");
    expect(logger.fatal).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) as Error }),
      expect.stringContaining("plugin timer"),
    );
  });

  it("ignores a second signal while draining", async () => {
    await startChatRun();
    const exit = vi.fn();
    const stopBackground = vi.fn();
    uninstall = installShutdownHandlers({ stopBackground, exit });

    process.emit("SIGTERM", "SIGTERM");
    process.emit("SIGTERM", "SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    expect(stopBackground).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
