import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetMockDb, seedDb, type Row } from "../../test-utils.ts";

// extractFiles is exercised by storage/utils tests. Here it stands in for the
// real one closely enough to show it ran before a write: every file part comes
// out carrying a storage reference.
vi.mock("../../storage/utils.ts", () => ({
  extractFiles: vi.fn((messages: PlatypusUIMessage[]) =>
    Promise.resolve(
      messages.map((message) => ({
        ...message,
        parts: message.parts.map((part) =>
          part.type === "file" ? { ...part, url: "storage://stored" } : part,
        ),
      })),
    ),
  ),
}));

// Titling is exercised by chat-metadata tests; stub it here so onFinish's
// fire-and-forget call doesn't touch the model or add stray db calls, and so
// we can assert when (and with what provider) the sink triggers it.
const { mockGenerateChatMetadata } = vi.hoisted(() => ({
  mockGenerateChatMetadata: vi.fn(),
}));
vi.mock("../../services/chat-metadata.ts", () => ({
  generateChatMetadata: mockGenerateChatMetadata,
}));

import { TaskState } from "@a2a-js/sdk";
import { ChatSink, type ChatSinkParams } from "./chat-sink.ts";
import type { Tx } from "../../index.ts";
import { a2aTask } from "../../db/schema.ts";
import type { TaskRow } from "../../services/a2a-task-state.ts";
import { endTurnIn, readTask } from "../../services/a2a-task-lifecycle.ts";
import { extractFiles } from "../../storage/utils.ts";
import { ConflictError } from "../../errors.ts";
import type { ResolvedRunPlan } from "../types.ts";
import type { PlatypusUIMessage } from "../../types.ts";

const planWithAgent: ResolvedRunPlan = {
  resolved: {
    agentId: "a1",
    providerId: "p1",
    modelId: "m1",
    // prepareChatTurn already nulls these for agent runs
    instructions: undefined,
    temperature: undefined,
    topP: undefined,
    topK: undefined,
    seed: undefined,
    presencePenalty: undefined,
    frequencyPenalty: undefined,
  },
};

const planAdhoc: ResolvedRunPlan = {
  resolved: {
    agentId: undefined,
    providerId: "p1",
    modelId: "m1",
    instructions: "raw instructions",
    temperature: 0.7,
    topP: 0.9,
    topK: 5,
    seed: 42,
    presencePenalty: 0.1,
    frequencyPenalty: 0.2,
    maxSteps: 25,
  },
};

const chatRow = (overrides: Row = {}): Row => ({
  id: "chat-1",
  workspaceId: "ws-1",
  title: "Untitled",
  status: "succeeded",
  activeLeafId: "a0",
  ...overrides,
});

const storedRow = (
  id: string,
  parentId: string | null,
  role: "user" | "assistant",
  overrides: Row = {},
): Row => ({
  chatId: "chat-1",
  id,
  parentId,
  role,
  parts: [{ type: "text", text: id }],
  metadata: null,
  deletedAt: null,
  ...overrides,
});

/** The Workspace the turns run in, owned by the Owner they act as. */
const workspace = [{ id: "ws-1", ownerId: "owner-1" }];

/** The Chat's primary key, which a turn's claim on a new Chat leans on. */
const chatPkey = { unique: { chat: [{ name: "chat_pkey", columns: ["id"] }] } };

/** A Chat holding one exchange, u0 → a0. */
const seedChat = (rows: Row[] = []) =>
  seedDb(
    {
      workspace,
      chat: [chatRow()],
      chat_message: [
        storedRow("u0", null, "user"),
        storedRow("a0", "u0", "assistant"),
        ...rows,
      ],
    },
    chatPkey,
  );

const u0: PlatypusUIMessage = {
  id: "u0",
  role: "user",
  parts: [{ type: "text", text: "u0" }],
};
const a0: PlatypusUIMessage = {
  id: "a0",
  role: "assistant",
  parts: [{ type: "text", text: "a0" }],
};
const u1: PlatypusUIMessage = {
  id: "u1",
  role: "user",
  parts: [
    { type: "file", mediaType: "image/png", url: "data:image/png;base64,AA" },
    { type: "text", text: "u1" },
  ],
};
const reply = (text: string, id = "r1"): PlatypusUIMessage => ({
  id,
  role: "assistant",
  parts: [{ type: "text", text }],
});

const submitSink = (overrides: Partial<ChatSinkParams> = {}) =>
  new ChatSink({
    orgId: "org-1",
    workspaceId: "ws-1",
    ownerId: "owner-1",
    message: u1,
    parentId: "a0",
    ...overrides,
  });

const rowOf = (fake: ReturnType<typeof seedDb>, table: string, id: string) =>
  fake.tables[table]?.find((row) => row.id === id);

/** Runs a submit turn to its end: start, resolve, finish with `final`. */
const runTurn = async (
  sink: ChatSink,
  start: PlatypusUIMessage[],
  final: PlatypusUIMessage[],
  plan: ResolvedRunPlan = planWithAgent,
) => {
  await sink.onStart({ runId: "chat-1", messages: start });
  await sink.onResolved({ runId: "chat-1", plan });
  await sink.onFinish({
    runId: "chat-1",
    status: "succeeded",
    messages: final,
    stats: {},
  });
};

describe("ChatSink", () => {
  beforeEach(() => {
    resetMockDb();
    mockGenerateChatMetadata.mockReset();
    mockGenerateChatMetadata.mockResolvedValue(null);
  });

  describe("onStart", () => {
    it("flips an existing Chat to running and adds the message under its parent", async () => {
      const fake = seedChat();

      await submitSink().onStart({ runId: "chat-1", messages: [u0, a0, u1] });

      expect(rowOf(fake, "chat", "chat-1")).toMatchObject({
        status: "running",
        activeLeafId: "u1",
      });
      expect(rowOf(fake, "chat_message", "u1")).toMatchObject({
        chatId: "chat-1",
        parentId: "a0",
        role: "user",
        // Files are stored before the row is written, never inline in it.
        parts: [
          { type: "file", mediaType: "image/png", url: "storage://stored" },
          { type: "text", text: "u1" },
        ],
      });
      expect(fake.tables.chat_message).toHaveLength(3);
    });

    it("creates a new Chat with its first message", async () => {
      const fake = seedDb({ workspace });

      await submitSink({ parentId: null }).onStart({
        runId: "chat-1",
        messages: [u1],
      });

      expect(rowOf(fake, "chat", "chat-1")).toMatchObject({
        workspaceId: "ws-1",
        title: "Untitled",
        status: "running",
        activeLeafId: "u1",
      });
      expect(rowOf(fake, "chat_message", "u1")?.parentId).toBeNull();
    });

    // So a reader arriving mid-run sees the message being answered, not the
    // reply being replaced — the same shape a submit shows before its reply.
    it("writes no message and moves the leaf to the reply's message on a regenerate", async () => {
      const fake = seedChat();

      await submitSink({ message: undefined, parentId: "u0" }).onStart({
        runId: "chat-1",
        messages: [u0],
      });

      expect(rowOf(fake, "chat", "chat-1")).toMatchObject({
        status: "running",
        activeLeafId: "u0",
      });
      expect(fake.tables.chat_message).toHaveLength(2);
    });

    it("fails, writing no message, on a Chat id another Workspace holds", async () => {
      const fake = seedDb(
        { workspace, chat: [chatRow({ workspaceId: "ws-other" })] },
        chatPkey,
      );

      await expect(
        submitSink({ parentId: null }).onStart({
          runId: "chat-1",
          messages: [u1],
        }),
      ).rejects.toThrow(ConflictError);
      expect(fake.tables.chat_message ?? []).toHaveLength(0);
    });

    // ADR-0035: a turn started as the old Owner must not land after a
    // transfer has listed the Chats it cancels, nor bring back a cleared Chat.
    it("refuses, writing nothing, once the Workspace has a new Owner", async () => {
      const fake = seedDb(
        { workspace: [{ id: "ws-1", ownerId: "owner-2" }], chat: [] },
        chatPkey,
      );

      await expect(
        submitSink({ parentId: null }).onStart({
          runId: "chat-1",
          messages: [u1],
        }),
      ).rejects.toThrow(ConflictError);
      expect(fake.tables.chat).toHaveLength(0);
      expect(fake.tables.chat_message ?? []).toHaveLength(0);
    });

    // The one-run-per-Chat lock, held in the row so it holds across backend
    // instances (#1237): the turn running here may be another process's.
    it.each([
      ["an existing Chat", () => seedChat()],
      [
        "a new Chat another instance just created",
        () => seedDb({ workspace, chat: [], chat_message: [] }, chatPkey),
      ],
    ])(
      "refuses a second turn on %s while one runs, and the loser writes nothing",
      async (_, seed) => {
        const fake = seed();
        const winner = submitSink({
          parentId: fake.tables.chat.length ? "a0" : null,
        });
        await winner.onStart({ runId: "chat-1", messages: [u1] });
        const before = structuredClone(fake.tables);

        const loser = submitSink({
          message: { ...u1, id: "u2" },
          parentId: null,
        });
        await expect(
          loser.onStart({ runId: "chat-1", messages: [u1] }),
        ).rejects.toThrow(ConflictError);
        // What the runner does with a start hook that threw.
        await loser.onFinish({
          runId: "chat-1",
          status: "failed",
          messages: [],
          stats: {},
        });

        expect(fake.tables).toEqual(before);
        expect(rowOf(fake, "chat", "chat-1")?.status).toBe("running");
      },
    );
  });

  // Issue #1297: a peer tells a live run from one lost with its instance by
  // the Chat's heartbeat.
  describe("run heartbeat", () => {
    const t0 = new Date("2026-08-30T12:00:00.000Z");
    const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(t0);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("stamps the claim, then every 15 seconds until the run ends", async () => {
      const fake = seedChat();
      const sink = submitSink();

      await sink.onStart({ runId: "chat-1", messages: [u0, a0, u1] });
      expect(rowOf(fake, "chat", "chat-1")?.runHeartbeatAt).toEqual(t0);

      await vi.advanceTimersByTimeAsync(15_000);
      expect(rowOf(fake, "chat", "chat-1")?.runHeartbeatAt).toEqual(at(15));
      await vi.advanceTimersByTimeAsync(15_000);
      expect(rowOf(fake, "chat", "chat-1")?.runHeartbeatAt).toEqual(at(30));

      await sink.onFinish({
        runId: "chat-1",
        status: "succeeded",
        messages: [u0, a0, u1],
        stats: {},
      });
      await vi.advanceTimersByTimeAsync(60_000);

      expect(rowOf(fake, "chat", "chat-1")?.runHeartbeatAt).toEqual(at(30));
    });

    it("takes a Chat whose run's heartbeat is a minute old", async () => {
      const fake = seedChat();
      Object.assign(rowOf(fake, "chat", "chat-1")!, {
        status: "running",
        runHeartbeatAt: t0,
      });
      vi.setSystemTime(at(61));

      await submitSink().onStart({ runId: "chat-1", messages: [u0, a0, u1] });

      expect(rowOf(fake, "chat", "chat-1")).toMatchObject({
        status: "running",
        activeLeafId: "u1",
        runHeartbeatAt: at(61),
      });
    });

    it("refuses a Chat whose run's heartbeat is fresh", async () => {
      const fake = seedChat();
      Object.assign(rowOf(fake, "chat", "chat-1")!, {
        status: "running",
        runHeartbeatAt: t0,
      });
      vi.setSystemTime(at(59));

      await expect(
        submitSink().onStart({ runId: "chat-1", messages: [u0, a0, u1] }),
      ).rejects.toThrow(ConflictError);
      expect(fake.tables.chat_message).toHaveLength(2);
    });
  });

  describe("onProgress + FlushScheduler", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("coalesces rapid bumps into a single flush of the reply", async () => {
      const fake = seedChat();
      const sink = submitSink({ flushIntervalMs: 100 });
      await sink.onStart({ runId: "chat-1", messages: [u0, a0, u1] });
      await sink.onResolved({ runId: "chat-1", plan: planWithAgent });

      const update = vi.spyOn(
        fake.handle as { transaction: () => unknown },
        "transaction",
      );
      const messages = [u0, a0, u1, reply("partial")];
      await sink.onProgress({ runId: "chat-1", messages, stats: {} });
      await sink.onProgress({ runId: "chat-1", messages, stats: {} });
      await sink.onProgress({ runId: "chat-1", messages, stats: {} });
      expect(update).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(100);

      expect(update).toHaveBeenCalledTimes(1);
      expect(rowOf(fake, "chat_message", "r1")).toMatchObject({
        parentId: "u1",
        role: "assistant",
        parts: [{ type: "text", text: "partial" }],
      });
      expect(rowOf(fake, "chat", "chat-1")).toMatchObject({
        status: "running",
        activeLeafId: "r1",
        agentId: "a1",
      });
    });

    // #1337: a Task reads `working` from the reply's first write.
    it("writes the reply at once on the run's first output", async () => {
      const fake = seedChat();
      const sink = submitSink({ flushIntervalMs: 5_000 });
      await sink.onStart({ runId: "chat-1", messages: [u0, a0, u1] });
      await sink.onResolved({ runId: "chat-1", plan: planWithAgent });

      await sink.onOutput({
        runId: "chat-1",
        messages: [u0, a0, u1, reply("He")],
      });

      expect(rowOf(fake, "chat_message", "r1")).toMatchObject({
        parentId: "u1",
        role: "assistant",
        parts: [{ type: "text", text: "He" }],
      });
      expect(rowOf(fake, "chat", "chat-1")).toMatchObject({
        status: "running",
        activeLeafId: "r1",
      });
    });

    it("keeps the scheduler's cadence for progress after the first output", async () => {
      const fake = seedChat();
      const sink = submitSink({ flushIntervalMs: 100 });
      await sink.onStart({ runId: "chat-1", messages: [u0, a0, u1] });
      await sink.onResolved({ runId: "chat-1", plan: planWithAgent });
      await sink.onOutput({
        runId: "chat-1",
        messages: [u0, a0, u1, reply("He")],
      });

      const update = vi.spyOn(
        fake.handle as { transaction: () => unknown },
        "transaction",
      );
      const messages = [u0, a0, u1, reply("Hello")];
      await sink.onProgress({ runId: "chat-1", messages, stats: {} });
      await sink.onProgress({ runId: "chat-1", messages, stats: {} });
      expect(update).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(100);
      expect(update).toHaveBeenCalledTimes(1);
    });

    it("dispose cancels pending flush in onFinish (no extra writes)", async () => {
      const fake = seedChat();
      const sink = submitSink({ flushIntervalMs: 1000 });
      await sink.onStart({ runId: "chat-1", messages: [u0, a0, u1] });
      await sink.onResolved({ runId: "chat-1", plan: planWithAgent });
      await sink.onProgress({
        runId: "chat-1",
        messages: [u0, a0, u1, reply("partial")],
        stats: {},
      });

      await sink.onFinish({
        runId: "chat-1",
        status: "succeeded",
        messages: [u0, a0, u1, reply("done")],
        stats: {},
      });

      const update = vi.spyOn(
        fake.handle as { transaction: () => unknown },
        "transaction",
      );
      await vi.advanceTimersByTimeAsync(2000);
      expect(update).not.toHaveBeenCalled();
      expect(rowOf(fake, "chat_message", "r1")?.parts).toEqual([
        { type: "text", text: "done" },
      ]);
    });
  });

  describe("the rows a turn writes", () => {
    it("never rewrites a row from history", async () => {
      const fake = seedChat();
      const rewritten = {
        ...a0,
        parts: [{ type: "text" as const, text: "!" }],
      };

      await runTurn(
        submitSink(),
        [u0, rewritten, u1],
        [u0, rewritten, u1, reply("r1")],
      );

      expect(rowOf(fake, "chat_message", "a0")?.parts).toEqual([
        { type: "text", text: "a0" },
      ]);
    });

    // The SDK continues a trailing assistant message under its id, so the
    // seeded `loadSkill` message and the reply are one row (issue #649).
    it("writes a /skill turn as two rows: the message and the seeded reply", async () => {
      vi.useFakeTimers();
      try {
        const fake = seedChat();
        const loadSkill = {
          type: "tool-loadSkill",
          toolCallId: "call-1",
          state: "output-available",
          input: { name: "blog-post" },
          output: { name: "blog-post", body: "Write a blog post." },
        } as unknown as PlatypusUIMessage["parts"][number];
        const seeded: PlatypusUIMessage = {
          id: "seed-1",
          role: "assistant",
          parts: [loadSkill],
        };
        const sink = submitSink({ flushIntervalMs: 100 });
        await sink.onStart({ runId: "chat-1", messages: [u0, a0, u1, seeded] });
        await sink.onResolved({ runId: "chat-1", plan: planWithAgent });

        // Before the first step, the seeded message is all the reply there is.
        await sink.onProgress({
          runId: "chat-1",
          messages: [u0, a0, u1, seeded],
          stats: {},
        });
        await vi.advanceTimersByTimeAsync(100);
        expect(rowOf(fake, "chat_message", "seed-1")?.parts).toEqual([
          loadSkill,
        ]);

        await sink.onFinish({
          runId: "chat-1",
          status: "succeeded",
          messages: [
            u0,
            a0,
            u1,
            {
              ...seeded,
              parts: [loadSkill, { type: "text", text: "Otters." }],
            },
          ],
          stats: {},
        });

        expect(fake.tables.chat_message.map((row) => row.id)).toEqual([
          "u0",
          "a0",
          "u1",
          "seed-1",
        ]);
        expect(rowOf(fake, "chat_message", "seed-1")).toMatchObject({
          parentId: "u1",
          parts: [loadSkill, { type: "text", text: "Otters." }],
        });
        expect(rowOf(fake, "chat", "chat-1")?.activeLeafId).toBe("seed-1");
      } finally {
        vi.useRealTimers();
      }
    });

    it("hangs a regenerated reply beside the old one", async () => {
      const fake = seedChat();

      await runTurn(
        submitSink({ message: undefined, parentId: "u0" }),
        [u0],
        [u0, reply("again", "a0b")],
      );

      expect(rowOf(fake, "chat_message", "a0")?.parts).toEqual([
        { type: "text", text: "a0" },
      ]);
      expect(rowOf(fake, "chat_message", "a0b")).toMatchObject({
        parentId: "u0",
        role: "assistant",
      });
      expect(rowOf(fake, "chat", "chat-1")?.activeLeafId).toBe("a0b");
    });

    it("writes no reply for a turn that ended before one began", async () => {
      const fake = seedChat();

      await runTurn(submitSink(), [u0, a0, u1], [u0, a0, u1]);

      expect(fake.tables.chat_message).toHaveLength(3);
      expect(rowOf(fake, "chat", "chat-1")?.activeLeafId).toBe("u1");
    });

    // The leaf sat on the reply's message for the run; with no new reply to
    // move on to, the old one goes back on the path rather than being left
    // off it with no arrows leading back.
    it("puts the leaf back on a regenerate that ended before a reply began", async () => {
      const fake = seedChat();

      await runTurn(
        submitSink({ message: undefined, parentId: "u0" }),
        [u0],
        [u0],
      );

      expect(fake.tables.chat_message).toHaveLength(2);
      expect(rowOf(fake, "chat", "chat-1")?.activeLeafId).toBe("a0");
    });

    it("does not bring back a reply deleted since the last write", async () => {
      const deletedAt = new Date("2026-01-01T00:00:00Z");
      const fake = seedChat([
        storedRow("u1", "a0", "user"),
        storedRow("r1", "u1", "assistant", { deletedAt }),
      ]);
      const sink = submitSink({ message: undefined, parentId: "u1" });
      await sink.onResolved({ runId: "chat-1", plan: planWithAgent });
      // A sink resumed mid-run: only its id matters here.
      await sink.onStart({ runId: "chat-1", messages: [u0, a0, u1] });

      await sink.onFinish({
        runId: "chat-1",
        status: "succeeded",
        messages: [u0, a0, u1, reply("final")],
        stats: {},
      });

      expect(rowOf(fake, "chat_message", "r1")).toMatchObject({
        parts: [{ type: "text", text: "final" }],
        deletedAt,
      });
    });

    it("does not recreate a Chat deleted mid-run", async () => {
      const fake = seedChat();
      const sink = submitSink();
      await sink.onStart({ runId: "chat-1", messages: [u0, a0, u1] });
      await sink.onResolved({ runId: "chat-1", plan: planWithAgent });
      fake.tables.chat.length = 0;

      await sink.onFinish({
        runId: "chat-1",
        status: "succeeded",
        messages: [u0, a0, u1, reply("r1")],
        stats: {},
      });

      expect(fake.tables.chat).toHaveLength(0);
    });
  });

  describe("onFinish — agent path", () => {
    it("writes status=succeeded with agentId and per-call generation fields nulled", async () => {
      const fake = seedChat();

      await runTurn(submitSink(), [u0, a0, u1], [u0, a0, u1, reply("r1")]);

      expect(rowOf(fake, "chat", "chat-1")).toMatchObject({
        status: "succeeded",
        agentId: "a1",
        providerId: null,
        modelId: null,
        instructions: null,
        temperature: null,
        topP: null,
        seed: null,
        presencePenalty: null,
        frequencyPenalty: null,
        maxSteps: null,
      });
    });

    // Issue #522's "the notice is present after a page reload" criterion. The
    // notice renders off `metadata.searchUnavailable`, so reload survival is
    // exactly whether the flag reaches the reply's row — what the Chat is
    // rebuilt from. Pinned here rather than inferred from the stream tests:
    // `onFinish` writes the reply through `extractFiles`, which rebuilds parts,
    // and nothing else asserts that it leaves metadata alone.
    it("persists per-turn message metadata on the reply's row", async () => {
      const fake = seedChat();
      const answered: PlatypusUIMessage = {
        ...reply("Answered without searching."),
        metadata: { agentId: "a1", searchUnavailable: true },
      };

      await runTurn(submitSink(), [u0, a0, u1], [u0, a0, u1, answered]);

      expect(rowOf(fake, "chat_message", "r1")?.metadata).toEqual({
        agentId: "a1",
        searchUnavailable: true,
      });
    });

    it("writes status=cancelled when the run was cancelled", async () => {
      const fake = seedChat();
      const sink = submitSink();
      await sink.onStart({ runId: "chat-1", messages: [u0, a0, u1] });
      await sink.onResolved({ runId: "chat-1", plan: planWithAgent });
      await sink.onFinish({
        runId: "chat-1",
        status: "cancelled",
        messages: [u0, a0, u1],
        stats: {},
      });

      expect(rowOf(fake, "chat", "chat-1")?.status).toBe("cancelled");
    });

    it("still writes the terminal status when storing the reply's files fails", async () => {
      const fake = seedChat();
      const sink = submitSink();
      await sink.onStart({ runId: "chat-1", messages: [u0, a0, u1] });
      await sink.onResolved({ runId: "chat-1", plan: planWithAgent });
      vi.mocked(extractFiles).mockRejectedValueOnce(new Error("storage down"));
      await sink.onFinish({
        runId: "chat-1",
        status: "succeeded",
        messages: [u0, a0, u1, reply("r1")],
        stats: {},
      });

      expect(rowOf(fake, "chat", "chat-1")?.status).toBe("failed");
      expect(rowOf(fake, "chat_message", "r1")).toBeUndefined();
    });
  });

  describe("onFinish — adhoc path", () => {
    it("persists provider/model and the resolved generation config", async () => {
      const fake = seedChat();

      await runTurn(submitSink(), [u0, a0, u1], [u0, a0, u1], planAdhoc);

      expect(rowOf(fake, "chat", "chat-1")).toMatchObject({
        agentId: null,
        providerId: "p1",
        modelId: "m1",
        instructions: "raw instructions",
        temperature: 0.7,
        topP: 0.9,
        topK: 5,
        seed: 42,
        presencePenalty: 0.1,
        frequencyPenalty: 0.2,
        maxSteps: 25,
      });
    });

    // Issue #539's #263 guard: a Direct turn with no per-chat maxSteps must
    // write the column null, not leave a previously-set value standing —
    // clearing only persists because every turn rewrites all generation
    // columns.
    it("writes maxSteps null when the direct turn carries none", async () => {
      const fake = seedDb({
        workspace,
        chat: [chatRow({ maxSteps: 10 })],
        chat_message: [
          storedRow("u0", null, "user"),
          storedRow("a0", "u0", "assistant"),
        ],
      });

      await runTurn(submitSink(), [u0, a0, u1], [u0, a0, u1], {
        resolved: { ...planAdhoc.resolved, maxSteps: undefined },
      });

      expect(rowOf(fake, "chat", "chat-1")?.maxSteps).toBeNull();
    });
  });

  describe("onFinish — no plan (resolution failed)", () => {
    it("updates only the status, keeping the stored message", async () => {
      const fake = seedChat();
      const sink = submitSink();
      await sink.onStart({ runId: "chat-1", messages: [u0, a0, u1] });
      // No onResolved — simulating prepareChatTurn failing
      await sink.onFinish({
        runId: "chat-1",
        status: "failed",
        messages: [u0, a0, u1, reply("never")],
        stats: {},
      });

      expect(rowOf(fake, "chat", "chat-1")).toMatchObject({
        status: "failed",
        activeLeafId: "u1",
      });
      expect(rowOf(fake, "chat_message", "r1")).toBeUndefined();
      expect(rowOf(fake, "chat", "chat-1")?.agentId).toBeUndefined();
    });

    it("puts the leaf back on a regenerate", async () => {
      const fake = seedChat();
      const sink = submitSink({ message: undefined, parentId: "u0" });
      await sink.onStart({ runId: "chat-1", messages: [u0] });
      await sink.onFinish({
        runId: "chat-1",
        status: "failed",
        messages: [u0],
        stats: {},
      });

      expect(rowOf(fake, "chat", "chat-1")).toMatchObject({
        status: "failed",
        activeLeafId: "a0",
      });
    });

    it("does not attempt titling when no plan resolved", async () => {
      seedChat();
      const sink = submitSink();
      await sink.onStart({ runId: "chat-1", messages: [u0, a0, u1] });
      await sink.onFinish({
        runId: "chat-1",
        status: "failed",
        messages: [],
        stats: {},
      });

      expect(mockGenerateChatMetadata).not.toHaveBeenCalled();
    });
  });

  describe("onFinish — titling", () => {
    it.each(["succeeded", "failed", "cancelled"] as const)(
      "fires fire-and-forget titling with the plan provider for status=%s",
      async (status) => {
        seedChat();
        const sink = submitSink();
        await sink.onStart({ runId: "chat-1", messages: [u0, a0, u1] });
        await sink.onResolved({ runId: "chat-1", plan: planWithAgent });
        await sink.onFinish({
          runId: "chat-1",
          status,
          messages: [u0, a0, u1],
          stats: {},
        });

        expect(mockGenerateChatMetadata).toHaveBeenCalledTimes(1);
        expect(mockGenerateChatMetadata).toHaveBeenCalledWith({
          chatId: "chat-1",
          workspaceId: "ws-1",
          orgId: "org-1",
          // Agent runs null the row's provider column, so titling must resolve
          // the provider from the plan (the agent's own provider).
          providerId: "p1",
        });
      },
    );

    it("does not block or fail run completion when titling rejects", async () => {
      seedChat();
      mockGenerateChatMetadata.mockRejectedValueOnce(new Error("boom"));
      const sink = submitSink();
      await sink.onStart({ runId: "chat-1", messages: [u0, a0, u1] });
      await sink.onResolved({ runId: "chat-1", plan: planWithAgent });

      // onFinish resolves cleanly even though titling throws asynchronously.
      await expect(
        sink.onFinish({
          runId: "chat-1",
          status: "succeeded",
          messages: [u0, a0, u1],
          stats: {},
        }),
      ).resolves.toBeUndefined();
      expect(mockGenerateChatMetadata).toHaveBeenCalledTimes(1);
    });
  });

  // A turn's end and the claim of the next can come from two instances. Here
  // the claim lands after the sink's first commit at its end, which is where
  // it can land against a sink that writes its end in more than one step.
  describe("a turn's end, against a claim of the next turn", () => {
    /** The A2A Task of the turn answering `messageId`, as the claim makes it. */
    const insertTask = (id: string, messageId: string) => async (tx: Tx) => {
      await tx.insert(a2aTask).values({
        id,
        chatId: "chat-1",
        messageId,
        endpointId: "ep-1",
        tokenId: "tok-1",
        state: null,
        replyId: null,
        statusAt: new Date(),
        createdAt: new Date(),
      });
    };

    /** Records the A2A Task's end for the turn answering `messageId`. */
    const endTask =
      (messageId: string): ChatSinkParams["onEnding"] =>
      (tx, status) =>
        endTurnIn(tx, "chat-1", messageId, status);

    /** Runs `claim` once, right after the next transaction commits. */
    const claimAfterCommit = (
      fake: ReturnType<typeof seedDb>,
      claim: () => Promise<void>,
    ) => {
      const handle = fake.handle as {
        transaction: (callback: (tx: unknown) => Promise<unknown>) => unknown;
      };
      const transaction = handle.transaction;
      handle.transaction = async (callback) => {
        handle.transaction = transaction;
        const result = await transaction(callback);
        await claim();
        return result;
      };
    };

    const readTaskRow = (fake: ReturnType<typeof seedDb>, id: string) =>
      readTask(rowOf(fake, "a2a_task", id) as TaskRow);

    const u2: PlatypusUIMessage = {
      id: "u2",
      role: "user",
      parts: [{ type: "text", text: "u2" }],
    };

    it("never reads the next turn's Task failed when a regenerate that wrote no reply ends", async () => {
      const fake = seedChat();
      const regenerate = submitSink({
        message: undefined,
        parentId: "u0",
        onEnding: endTask("u0"),
      });
      await regenerate.onStart({ runId: "chat-1", messages: [u0] });
      await regenerate.onResolved({ runId: "chat-1", plan: planWithAgent });
      const next = submitSink({
        message: u2,
        parentId: "a0",
        onClaimed: insertTask("task-2", "u2"),
      });
      claimAfterCommit(fake, () =>
        next.onStart({ runId: "chat-1", messages: [u0, a0, u2] }),
      );

      await regenerate.onFinish({
        runId: "chat-1",
        status: "cancelled",
        messages: [u0],
        stats: {},
      });

      expect(rowOf(fake, "chat", "chat-1")).toMatchObject({
        status: "running",
        activeLeafId: "u2",
      });
      expect((await readTaskRow(fake, "task-2")).status!.state).toBe(
        TaskState.TASK_STATE_SUBMITTED,
      );
      await next.onFinish({
        runId: "chat-1",
        status: "cancelled",
        messages: [u0, a0, u2],
        stats: {},
      });
    });

    it("never reads a canceled turn's Task completed for the reply it began", async () => {
      const fake = seedChat();
      fake.tables.a2a_task = [];
      const canceled = submitSink({
        onClaimed: insertTask("task-1", "u1"),
        onEnding: endTask("u1"),
      });
      await canceled.onStart({ runId: "chat-1", messages: [u0, a0, u1] });
      await canceled.onResolved({ runId: "chat-1", plan: planWithAgent });
      const next = submitSink({
        message: u2,
        parentId: "r1",
        onClaimed: insertTask("task-2", "u2"),
      });
      claimAfterCommit(fake, () =>
        next.onStart({
          runId: "chat-1",
          messages: [u0, a0, u1, reply("Let me ch"), u2],
        }),
      );

      await canceled.onFinish({
        runId: "chat-1",
        status: "cancelled",
        messages: [u0, a0, u1, reply("Let me ch")],
        stats: {},
      });

      expect(rowOf(fake, "chat", "chat-1")?.activeLeafId).toBe("u2");
      expect((await readTaskRow(fake, "task-1")).status!.state).toBe(
        TaskState.TASK_STATE_CANCELED,
      );
      expect(rowOf(fake, "a2a_task", "task-1")).toMatchObject({
        state: "canceled",
        replyId: "r1",
      });
      await next.onFinish({
        runId: "chat-1",
        status: "cancelled",
        messages: [u0, a0, u1, reply("Let me ch"), u2],
        stats: {},
      });
    });

    it("still ends the Chat when the turn's end cannot be recorded", async () => {
      const fake = seedChat();
      const sink = submitSink({
        onEnding: () => Promise.reject(new Error("db down")),
      });
      await sink.onStart({ runId: "chat-1", messages: [u0, a0, u1] });
      await sink.onResolved({ runId: "chat-1", plan: planWithAgent });

      await sink.onFinish({
        runId: "chat-1",
        status: "succeeded",
        messages: [u0, a0, u1, reply("r1")],
        stats: {},
      });

      expect(rowOf(fake, "chat", "chat-1")?.status).toBe("failed");
    });
  });
});
