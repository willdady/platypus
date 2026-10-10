import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetMockDb, seedDb } from "../test-utils.ts";

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
});
