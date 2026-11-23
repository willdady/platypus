import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetMockDb, seedDb, type Row } from "../../test-utils.ts";

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

const { mockGenerateChatMetadata, mockStartEarlyChatTitle } = vi.hoisted(
  () => ({
    mockGenerateChatMetadata: vi.fn(),
    mockStartEarlyChatTitle: vi.fn(),
  }),
);
vi.mock("../../services/chat-metadata.ts", () => ({
  generateChatMetadata: mockGenerateChatMetadata,
  startEarlyChatTitle: mockStartEarlyChatTitle,
}));

const { mockAfterTurn } = vi.hoisted(() => ({ mockAfterTurn: vi.fn() }));
vi.mock("../../services/chat-summary.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../services/chat-summary.ts")>();
  return {
    ...actual,
    afterTurn: mockAfterTurn,
  };
});

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
import type { ConcreteModelId } from "@platypus/schemas";

const planWithAgent: ResolvedRunPlan = {
  resolved: {
    agentId: "a1",
    providerId: "p1",
    modelId: "m1",
    instructions: undefined,
    temperature: undefined,
    topP: undefined,
    topK: undefined,
    seed: undefined,
    presencePenalty: undefined,
    frequencyPenalty: undefined,
  },
  resolvedModelId: "m1" as ConcreteModelId,
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
  resolvedModelId: "m1" as ConcreteModelId,
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

const workspace = [{ id: "ws-1", ownerId: "owner-1" }];

const chatPkey = { unique: { chat: [{ name: "chat_pkey", columns: ["id"] }] } };

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
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a table no test seeded or wrote is absent
  fake.tables[table]?.find((row) => row.id === id);

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
    mockStartEarlyChatTitle.mockReset();
    mockStartEarlyChatTitle.mockResolvedValue(undefined);
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
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a table no test seeded or wrote is absent
      expect(fake.tables.chat_message ?? []).toHaveLength(0);
    });

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
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a table no test seeded or wrote is absent
      expect(fake.tables.chat_message ?? []).toHaveLength(0);
    });

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

  describe("answered tool approvals", () => {
    const call = (state: string, approval: Record<string, unknown>) => ({
      type: "tool-wipe",
      toolCallId: "tc1",
      state,
      input: {},
      approval: { id: "ap1", ...approval },
    });
    const waitingParts = [call("approval-requested", {})];
    const answered: PlatypusUIMessage = {
      ...a0,
      parts: [call("approval-responded", { approved: true })],
    } as unknown as PlatypusUIMessage;
    const resumeSink = () =>
      submitSink({ message: undefined, parentId: "a0", answered: [answered] });

    it("writes the answers with the claim", async () => {
      const fake = seedChat();
      rowOf(fake, "chat_message", "a0")!.parts = waitingParts;

      await resumeSink().onStart({ runId: "chat-1", messages: [u0, answered] });

      expect(rowOf(fake, "chat_message", "a0")?.parts).toEqual(answered.parts);
      expect(rowOf(fake, "chat", "chat-1")?.activeLeafId).toBe("a0");
    });

    it("refuses a resume whose approvals another turn has answered", async () => {
      const fake = seedChat();
      const already = [call("output-available", { approved: true })];
      rowOf(fake, "chat_message", "a0")!.parts = already;

      await expect(
        resumeSink().onStart({ runId: "chat-1", messages: [u0, answered] }),
      ).rejects.toBeInstanceOf(ConflictError);
      expect(rowOf(fake, "chat_message", "a0")?.parts).toEqual(already);
      expect(rowOf(fake, "chat", "chat-1")?.status).not.toBe("running");
    });

    it("leaves a reply another turn has answered when a new message moves on", async () => {
      const fake = seedChat();
      const already = [call("output-available", { approved: true })];
      rowOf(fake, "chat_message", "a0")!.parts = already;

      await submitSink({ answered: [answered] }).onStart({
        runId: "chat-1",
        messages: [u0, answered, u1],
      });

      expect(rowOf(fake, "chat_message", "a0")?.parts).toEqual(already);
      expect(rowOf(fake, "chat", "chat-1")?.status).toBe("running");
    });
  });

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
    it("stores the message and reply without NUL, lone surrogates as U+FFFD", async () => {
      const fake = seedChat();
      const message: PlatypusUIMessage = {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "lo\u0000gs" }],
      };
      const tool = (output: string) =>
        ({
          type: "tool-readLogs",
          toolCallId: "call-1",
          state: "output-available",
          input: {},
          output,
        }) as unknown as PlatypusUIMessage["parts"][number];
      const final: PlatypusUIMessage = {
        id: "r1",
        role: "assistant",
        parts: [
          tool("line\u0000one"),
          { type: "text", text: "cut \uD83D" },
          { type: "text", text: "\uDE00 cut" },
        ],
      };

      await runTurn(
        submitSink({ message }),
        [u0, a0, message],
        [u0, a0, message, final],
      );

      expect(rowOf(fake, "chat_message", "u1")?.parts).toEqual([
        { type: "text", text: "logs" },
      ]);
      expect(rowOf(fake, "chat_message", "r1")?.parts).toEqual([
        tool("lineone"),
        { type: "text", text: "cut �" },
        { type: "text", text: "� cut" },
      ]);
      expect(rowOf(fake, "chat", "chat-1")?.status).toBe("succeeded");
    });

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
        ...planAdhoc,
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

  describe("onResolved — early titling", () => {
    it("starts an early attempt with the turn's provider and concrete model", async () => {
      seedChat();
      const sink = submitSink();
      await sink.onStart({ runId: "chat-1", messages: [u0, a0, u1] });
      await sink.onResolved({ runId: "chat-1", plan: planWithAgent });

      expect(mockStartEarlyChatTitle).toHaveBeenCalledTimes(1);
      expect(mockStartEarlyChatTitle).toHaveBeenCalledWith({
        chatId: "chat-1",
        workspaceId: "ws-1",
        orgId: "org-1",
        providerId: "p1",
        modelId: "m1",
      });
    });

    it("hands over the concrete model even when the Chat names it through an alias", async () => {
      seedChat();
      const sink = submitSink();
      await sink.onStart({ runId: "chat-1", messages: [u0, a0, u1] });
      await sink.onResolved({
        runId: "chat-1",
        plan: {
          resolved: { ...planWithAgent.resolved, modelId: "alias:fast" },
          resolvedModelId: "m1" as ConcreteModelId,
        },
      });

      expect(mockStartEarlyChatTitle).toHaveBeenCalledWith(
        expect.objectContaining({ modelId: "m1" }),
      );
    });

    it("waits for the early attempt before its own end-of-run attempt", async () => {
      seedChat();
      let settle!: () => void;
      mockStartEarlyChatTitle.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
      );
      const sink = submitSink();
      await sink.onStart({ runId: "chat-1", messages: [u0, a0, u1] });
      await sink.onResolved({ runId: "chat-1", plan: planWithAgent });

      await sink.onFinish({
        runId: "chat-1",
        status: "succeeded",
        messages: [u0, a0, u1],
        stats: {},
      });

      expect(mockGenerateChatMetadata).not.toHaveBeenCalled();

      settle();
      await vi.waitFor(() =>
        expect(mockGenerateChatMetadata).toHaveBeenCalledTimes(1),
      );
    });

    it("still attempts a title at the end when the early attempt failed", async () => {
      const fake = seedChat();
      mockStartEarlyChatTitle.mockRejectedValueOnce(new Error("boom"));
      const sink = submitSink();
      await sink.onStart({ runId: "chat-1", messages: [u0, a0, u1] });
      await sink.onResolved({ runId: "chat-1", plan: planWithAgent });

      await expect(
        sink.onFinish({
          runId: "chat-1",
          status: "succeeded",
          messages: [u0, a0, u1],
          stats: {},
        }),
      ).resolves.toBeUndefined();

      await vi.waitFor(() =>
        expect(mockGenerateChatMetadata).toHaveBeenCalledTimes(1),
      );
      expect(rowOf(fake, "chat", "chat-1")?.status).toBe("succeeded");
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

  describe("a turn's end, against a claim of the next turn", () => {
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

    const endTask =
      (messageId: string): ChatSinkParams["onEnding"] =>
      (tx, status) =>
        endTurnIn(tx, "chat-1", messageId, status);

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

  describe("onFinish — after-turn Transcript summary", () => {
    const withReading = (
      inputTokens: number,
      summaryId?: string,
    ): PlatypusUIMessage => ({
      ...reply("r1"),
      metadata: {
        contextOccupancy: { inputTokens, outputTokens: 100 },
        ...(summaryId ? { summaryId } : {}),
      },
    });

    const runWith = async (
      plan: ResolvedRunPlan,
      final: PlatypusUIMessage[],
    ) => {
      const sink = submitSink();
      await sink.onStart({ runId: "chat-1", messages: [u0, a0, u1] });
      await sink.onResolved({ runId: "chat-1", plan });
      await sink.onFinish({
        runId: "chat-1",
        status: "succeeded",
        messages: final,
        stats: {},
      });
    };

    beforeEach(() => {
      mockAfterTurn.mockReset();
    });

    const windowed: ResolvedRunPlan = {
      ...planWithAgent,
      contextWindow: 10_000,
    };

    it("hands the finished path, window and the Chat's own Agent source to afterTurn", async () => {
      seedChat();
      const final = [u0, a0, u1, withReading(8_100)];
      await runWith(windowed, final);

      expect(mockAfterTurn).toHaveBeenCalledTimes(1);
      const args = mockAfterTurn.mock.calls[0][0] as {
        chatId: string;
        orgId: string;
        workspaceId: string;
        path: PlatypusUIMessage[];
        contextWindow?: number;
        source: unknown;
      };
      expect(args).toMatchObject({
        chatId: "chat-1",
        orgId: "org-1",
        workspaceId: "ws-1",
        contextWindow: 10_000,
        source: { agentId: "a1" },
      });
      expect(args.path.map((message) => message.id)).toEqual(
        final.map((message) => message.id),
      );
    });

    it("hands a Direct turn's Provider + model reference", async () => {
      seedChat();
      await runWith({ ...planAdhoc, contextWindow: 10_000 }, [
        u0,
        a0,
        u1,
        withReading(8_100),
      ]);

      expect(mockAfterTurn.mock.calls[0][0]).toMatchObject({
        source: { providerId: "p1", modelId: "m1" },
      });
    });

    it("does not schedule when no plan resolved", async () => {
      seedChat();
      const sink = submitSink();
      await sink.onStart({ runId: "chat-1", messages: [u0, a0, u1] });
      await sink.onFinish({
        runId: "chat-1",
        status: "succeeded",
        messages: [u0, a0, u1, withReading(8_100)],
        stats: {},
      });

      expect(mockAfterTurn).not.toHaveBeenCalled();
    });

    it("schedules after a cancelled turn that stored its reply", async () => {
      seedChat();
      const sink = submitSink();
      await sink.onStart({ runId: "chat-1", messages: [u0, a0, u1] });
      await sink.onResolved({ runId: "chat-1", plan: windowed });
      await sink.onFinish({
        runId: "chat-1",
        status: "cancelled",
        messages: [u0, a0, u1, withReading(8_100)],
        stats: {},
      });

      expect(mockAfterTurn).toHaveBeenCalledTimes(1);
    });

    it("does not schedule when the reply could not be stored", async () => {
      seedChat();
      const sink = submitSink();
      await sink.onStart({ runId: "chat-1", messages: [u0, a0, u1] });
      await sink.onResolved({ runId: "chat-1", plan: windowed });
      vi.mocked(extractFiles).mockRejectedValueOnce(new Error("storage down"));
      await sink.onFinish({
        runId: "chat-1",
        status: "succeeded",
        messages: [u0, a0, u1, withReading(8_100)],
        stats: {},
      });

      expect(mockAfterTurn).not.toHaveBeenCalled();
    });
  });
});

describe("ChatSink — a Trigger run's Chat", () => {
  beforeEach(() => {
    resetMockDb();
    mockGenerateChatMetadata.mockReset();
    mockStartEarlyChatTitle.mockReset();
    mockStartEarlyChatTitle.mockResolvedValue(undefined);
    mockAfterTurn.mockReset();
  });

  const instruction: PlatypusUIMessage = {
    id: "m-user",
    role: "user",
    parts: [{ type: "text", text: "Summarise the board" }],
  };

  it("creates the Chat bound to its run with the run's messages, and never titles or summarises it", async () => {
    const fake = seedDb({ workspace }, chatPkey);
    const sink = submitSink({
      message: instruction,
      parentId: null,
      newChat: {
        agentId: "a1",
        triggerRunId: "chat-1",
        title: "Digest · 2026-11-07 09:00 UTC",
      },
    });

    await runTurn(sink, [instruction], [instruction, reply("done")], {
      ...planWithAgent,
      contextWindow: 10,
    });

    expect(rowOf(fake, "chat", "chat-1")).toMatchObject({
      triggerRunId: "chat-1",
      agentId: "a1",
      title: "Digest · 2026-11-07 09:00 UTC",
      status: "succeeded",
      activeLeafId: "r1",
    });
    expect(rowOf(fake, "chat", "chat-1")).not.toHaveProperty("tags");
    expect(rowOf(fake, "chat_message", "m-user")).toMatchObject({
      role: "user",
      parentId: null,
    });
    expect(rowOf(fake, "chat_message", "r1")).toMatchObject({
      role: "assistant",
      parentId: "m-user",
    });
    expect(mockGenerateChatMetadata).not.toHaveBeenCalled();
    expect(mockStartEarlyChatTitle).not.toHaveBeenCalled();
    expect(mockAfterTurn).not.toHaveBeenCalled();
  });
});
