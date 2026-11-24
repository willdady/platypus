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
import { RunRegistry } from "./run-registry.ts";
import { ChatSink } from "./sinks/chat-sink.ts";
import type { RunStatus } from "./types.ts";

let registry: RunRegistry;

const startChatRun = async (runs: RunRegistry) => {
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
    registry: runs,
    onTerminate: ({ status }) =>
      sink.onFinish({ runId: "chat-1", status, messages: [], stats: {} }),
  });
  return fake;
};

beforeEach(() => {
  registry = new RunRegistry();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("drainRuns", () => {
  it("cancels every held run and waits for each to write its end", async () => {
    const ended: RunStatus[] = [];
    for (const runId of ["run-a", "run-b"]) {
      startRun({
        runId,
        registry,
        onTerminate: async ({ status }) => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          ended.push(status);
        },
      });
    }

    expect(await drainRuns(1_000, registry)).toBe(true);

    expect(ended).toEqual(["cancelled", "cancelled"]);
    expect(registry.has("run-a")).toBe(false);
    expect(registry.has("run-b")).toBe(false);
  });

  it("gives up after its bound on a run that never ends", async () => {
    vi.useFakeTimers();
    startRun({
      runId: "stuck",
      registry,
      onTerminate: () => new Promise(() => {}),
    });

    const drained = drainRuns(8_000, registry);
    await vi.advanceTimersByTimeAsync(8_000);

    expect(await drained).toBe(false);
    expect(registry.stopping).toBe(true);
  });

  it("resolves at once with nothing held", async () => {
    expect(await drainRuns(1_000, registry)).toBe(true);
  });
});

describe("installShutdownHandlers", () => {
  let uninstall = () => {};

  beforeEach(() => {
    resetMockDb();
  });

  afterEach(() => {
    uninstall();
  });

  it.each(["SIGTERM", "SIGINT"] as const)(
    "on %s, ends the held Chat run as cancelled before exiting",
    async (signal) => {
      const fake = await startChatRun(registry);
      expect(fake.tables.chat[0].status).toBe("running");
      const order: string[] = [];
      const exit = vi.fn((code: number) => {
        order.push(`exit ${code}`);
        order.push(`chat ${String(fake.tables.chat[0].status)}`);
      });
      uninstall = installShutdownHandlers({
        registry,
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
    await startChatRun(registry);
    const exit = vi.fn();
    const stopAccepting = vi.fn();
    uninstall = installShutdownHandlers({ registry, stopAccepting, exit });

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
        registry,
        onTerminate: async ({ status }) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          ended.push(status);
        },
      });
    }

    const order: string[] = [];
    const exit = vi.fn((code: number) => order.push(`exit ${code}`));
    uninstall = installShutdownHandlers({
      registry,
      stopBackground: () => order.push("stop background"),
      stopAccepting: () => order.push("stop accepting"),
      closeIdleConnections: () => order.push("close idle connections"),
      close: () => {
        order.push("close");
        return Promise.resolve();
      },
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
    expect(ended).toEqual(["cancelled", "cancelled"]);
  });

  it("refuses new runs once the drain has started (503, not a new run)", async () => {
    startRun({
      runId: "held",
      registry,
      onTerminate: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      },
    });
    const exit = vi.fn();
    uninstall = installShutdownHandlers({ registry, exit, timeoutMs: 2_000 });

    process.emit("SIGTERM", "SIGTERM");
    expect(() =>
      startRun({ runId: "late", registry, onTerminate: () => {} }),
    ).toThrow("Server is shutting down");

    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    expect(exit).toHaveBeenCalledWith(0);
    expect(registry.has("late")).toBe(false);
    expect(registry.has("held")).toBe(false);
  });

  it("exits 1 when the drain times out on a run that never ends", async () => {
    vi.useFakeTimers();
    startRun({
      runId: "stuck",
      registry,
      onTerminate: () => new Promise(() => {}),
    });
    const exit = vi.fn();
    const endPool = vi.fn(() => Promise.resolve());
    uninstall = installShutdownHandlers({
      registry,
      exit,
      endPool,
      timeoutMs: 8_000,
    });

    process.emit("SIGTERM", "SIGTERM");
    await vi.advanceTimersByTimeAsync(8_000);

    expect(exit).toHaveBeenCalledWith(1);
    expect(endPool).not.toHaveBeenCalled();
    registry.unregister("stuck");
  });

  it("still ends the pool when the drain is stopped by a timeout, if budget remains", async () => {
    vi.useFakeTimers();
    const close = vi.fn(
      () => new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    );
    const endPool = vi.fn(() => Promise.resolve());
    const exit = vi.fn();
    uninstall = installShutdownHandlers({
      registry,
      close,
      endPool,
      exit,
      timeoutMs: 4_000,
    });

    process.emit("SIGTERM", "SIGTERM");
    await vi.advanceTimersByTimeAsync(4_000);

    expect(close).toHaveBeenCalledTimes(1);
    expect(endPool).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe("installCrashHandlers", () => {
  let uninstall = () => {};

  afterEach(() => {
    uninstall();
  });

  it("logs a rejection fatal, drains the held runs, and exits 1", async () => {
    const ended: RunStatus[] = [];
    for (const runId of ["crash-a"]) {
      startRun({
        runId,
        registry,
        onTerminate: async ({ status }) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          ended.push(status);
        },
      });
    }
    const exit = vi.fn();
    const fatal = vi.spyOn(logger, "fatal").mockImplementation(() => undefined);
    uninstall = installCrashHandlers({ registry, exit, timeoutMs: 1_000 });

    process.emit("unhandledRejection", new Error("boom"));
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    expect(fatal).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
    expect(ended).toEqual(["cancelled"]);
    fatal.mockRestore();
  });

  it("ignores a second crash while the first one drains", async () => {
    vi.useFakeTimers();
    startRun({
      runId: "stuck",
      registry,
      onTerminate: () => new Promise(() => {}),
    });
    const exit = vi.fn();
    uninstall = installCrashHandlers({ registry, exit, timeoutMs: 8_000 });

    process.emit("uncaughtException", new Error("boom1"));
    process.emit("uncaughtException", new Error("boom2"));
    await vi.advanceTimersByTimeAsync(8_000);

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    registry.unregister("stuck");
  });
});
