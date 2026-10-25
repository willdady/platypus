import { describe, it, expect, beforeEach } from "vitest";
import { resetMockDb, seedDb, type Row } from "../test-utils.ts";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import {
  deleteMessage,
  loadActivePath,
  MOVED_ON_REASON,
  resolveTurn,
  USER_DENIED_REASON,
} from "./chat-messages.ts";

const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));

const row = (
  id: string,
  parentId: string | null,
  role: "user" | "assistant",
  seconds: number,
  extra: Row = {},
): Row => ({
  chatId: "chat-1",
  id,
  parentId,
  role,
  parts: [{ type: "text", text: id }],
  metadata: null,
  deletedAt: null,
  createdAt: at(seconds),
  ...extra,
});

/**
 *   u1 ─ a1 ─ u2 ─ a2        (the Active path, leaf a2)
 *          └─ u2b             (an edit of u2: an Alternative)
 */
const tree = () => [
  row("u1", null, "user", 1),
  row("a1", "u1", "assistant", 2, { metadata: { contextOccupancy: 10 } }),
  row("u2", "a1", "user", 3),
  row("a2", "u2", "assistant", 4),
  row("u2b", "a1", "user", 5),
];

const text = (id: string) => ({ type: "text", text: id });

const submit = (overrides: Record<string, unknown> = {}) => ({
  message: { id: "u3", role: "user" as const, parts: [text("u3")] },
  parentId: "a2" as string | null,
  ...overrides,
});

describe("chat messages", () => {
  beforeEach(() => resetMockDb());

  describe("loadActivePath", () => {
    it("walks from the leaf to the root, in order, leaving Alternatives out", async () => {
      seedDb({ chat_message: tree() });

      const { messages } = await loadActivePath("chat-1", "a2");

      expect(messages).toEqual([
        { id: "u1", role: "user", parts: [text("u1")] },
        {
          id: "a1",
          role: "assistant",
          parts: [text("a1")],
          metadata: { contextOccupancy: 10 },
        },
        { id: "u2", role: "user", parts: [text("u2")] },
        { id: "a2", role: "assistant", parts: [text("a2")] },
      ]);
    });

    it("skips a deleted message and keeps the messages under it", async () => {
      const rows = tree();
      rows[2].deletedAt = at(9);
      seedDb({ chat_message: rows });

      const { messages } = await loadActivePath("chat-1", "a2");

      expect(messages.map((m) => m.id)).toEqual(["u1", "a1", "a2"]);
    });

    it("lists every live message in the tree, oldest first", async () => {
      const rows = tree().reverse();
      rows[0].deletedAt = at(9); // u2b
      seedDb({ chat_message: rows });

      const { tree: nodes } = await loadActivePath("chat-1", "a2");

      expect(nodes).toEqual([
        { id: "u1", parentId: null },
        { id: "a1", parentId: "u1" },
        { id: "u2", parentId: "a1" },
        { id: "a2", parentId: "u2" },
      ]);
    });

    it("is empty for a Chat with no leaf", async () => {
      seedDb({});
      expect(await loadActivePath("chat-1", null)).toEqual({
        messages: [],
        tree: [],
      });
    });

    it("reads only its own Chat's rows", async () => {
      seedDb({
        chat_message: [
          ...tree(),
          { ...row("u1", null, "user", 1), chatId: "chat-2", parts: [] },
        ],
      });

      const { messages } = await loadActivePath("chat-1", "a2");

      expect(messages[0].parts).toEqual([text("u1")]);
    });
  });

  describe("resolveTurn: submit", () => {
    it("continues the path it names and appends the new message", async () => {
      seedDb({ chat_message: tree() });

      const turn = await resolveTurn({
        chatId: "chat-1",
        owned: true,
        request: submit(),
      });

      expect(turn.messages.map((m) => m.id)).toEqual([
        "u1",
        "a1",
        "u2",
        "a2",
        "u3",
      ]);
      expect(turn.message).toEqual({
        id: "u3",
        role: "user",
        parts: [text("u3")],
      });
      expect(turn.parentId).toBe("a2");
    });

    it("continues a stale path, not the Chat's current leaf", async () => {
      seedDb({ chat_message: tree() });

      const turn = await resolveTurn({
        chatId: "chat-1",
        owned: true,
        request: submit({ parentId: "u2b" }),
      });

      expect(turn.messages.map((m) => m.id)).toEqual(["u1", "a1", "u2b", "u3"]);
    });

    it("hangs from a deleted parent, leaving it out of the history", async () => {
      const rows = tree();
      rows[3].deletedAt = at(9); // a2
      seedDb({ chat_message: rows });

      const turn = await resolveTurn({
        chatId: "chat-1",
        owned: true,
        request: submit(),
      });

      expect(turn.parentId).toBe("a2");
      expect(turn.messages.map((m) => m.id)).toEqual(["u1", "a1", "u2", "u3"]);
    });

    it("opens a new Chat with only the message", async () => {
      seedDb({});

      const turn = await resolveTurn({
        chatId: "chat-new",
        owned: false,
        request: submit({ parentId: null }),
      });

      expect(turn.messages.map((m) => m.id)).toEqual(["u3"]);
      expect(turn.parentId).toBeNull();
    });

    it("404s a parent that is not in the Chat", async () => {
      seedDb({ chat_message: tree() });

      await expect(
        resolveTurn({
          chatId: "chat-1",
          owned: true,
          request: submit({ parentId: "nope" }),
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("404s any parent on a Chat this Workspace does not own", async () => {
      seedDb({ chat_message: tree() });

      await expect(
        resolveTurn({ chatId: "chat-1", owned: false, request: submit() }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("409s a message id the Chat already holds", async () => {
      seedDb({ chat_message: tree() });

      await expect(
        resolveTurn({
          chatId: "chat-1",
          owned: true,
          request: submit({
            message: { id: "u2b", role: "user", parts: [text("again")] },
          }),
        }),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("400s a message the AI SDK refuses", async () => {
      seedDb({ chat_message: tree() });

      await expect(
        resolveTurn({
          chatId: "chat-1",
          owned: true,
          request: submit({
            message: { id: "u3", role: "user", parts: [{ type: "text" }] },
          }),
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe("resolveTurn: regenerate", () => {
    const regenerate = (messageId: string) => ({
      trigger: "regenerate-message" as const,
      messageId,
    });

    it("runs from the reply's parent", async () => {
      seedDb({ chat_message: tree() });

      const turn = await resolveTurn({
        chatId: "chat-1",
        owned: true,
        request: regenerate("a2"),
      });

      expect(turn.messages.map((m) => m.id)).toEqual(["u1", "a1", "u2"]);
      expect(turn.parentId).toBe("u2");
      expect(turn.message).toBeUndefined();
    });

    const notAReply = "Only a reply still in the Chat can regenerate";
    const messageGone =
      "This reply's message is no longer in the Chat, so it cannot regenerate";
    const notYours = "Only a reply to one of your messages can regenerate";

    it.each([
      [
        "a message that is not in the Chat",
        (rows: Row[]) => rows,
        "nope",
        notAReply,
      ],
      ["a user message", (rows: Row[]) => rows, "u2", notAReply],
      [
        "a deleted reply",
        (rows: Row[]) => {
          rows[3].deletedAt = at(9);
          return rows;
        },
        "a2",
        notAReply,
      ],
      [
        "a reply whose message was deleted",
        (rows: Row[]) => {
          rows[2].deletedAt = at(9);
          return rows;
        },
        "a2",
        messageGone,
      ],
      [
        "a reply that opens the Chat",
        () => [row("a0", null, "assistant", 1)],
        "a0",
        notYours,
      ],
      [
        "a reply that follows another reply",
        () => [
          row("u1", null, "user", 1),
          row("a1", "u1", "assistant", 2),
          row("a2", "a1", "assistant", 3),
        ],
        "a2",
        notYours,
      ],
    ])("409s %s", async (_, shape, messageId, error) => {
      seedDb({ chat_message: shape(tree()) });

      const turn = resolveTurn({
        chatId: "chat-1",
        owned: true,
        request: regenerate(messageId),
      });
      await expect(turn).rejects.toBeInstanceOf(ConflictError);
      await expect(turn).rejects.toThrow(error);
    });
  });

  describe("tool approvals", () => {
    const asked = (toolCallId: string, approvalId: string) => ({
      type: "tool-wipe",
      toolCallId,
      state: "approval-requested",
      input: { path: "/data" },
      approval: { id: approvalId, requestReason: "Looks risky." },
    });
    const responded = (
      toolCallId: string,
      approvalId: string,
      approved: boolean,
      reason?: string,
    ) => ({
      ...asked(toolCallId, approvalId),
      state: "approval-responded",
      approval: {
        id: approvalId,
        requestReason: "Looks risky.",
        approved,
        ...(reason ? { reason } : {}),
      },
    });

    /** `tree()` with a2 waiting on two approvals. */
    const waiting = () => {
      const rows = tree();
      rows[3].parts = [text("a2"), asked("tc1", "ap1"), asked("tc2", "ap2")];
      return rows;
    };

    const respond = (
      responses: { approvalId: string; approved: boolean }[],
      messageId = "a2",
    ) => ({
      trigger: "respond-to-approvals" as const,
      messageId,
      responses,
    });

    const BOTH = [
      { approvalId: "ap1", approved: true },
      { approvalId: "ap2", approved: false },
    ];

    it("continues the reply with each answer written onto its part", async () => {
      seedDb({ chat_message: waiting() });

      const turn = await resolveTurn({
        chatId: "chat-1",
        owned: true,
        activeLeafId: "a2",
        request: respond(BOTH),
      });

      const reply = {
        id: "a2",
        role: "assistant",
        parts: [
          text("a2"),
          responded("tc1", "ap1", true),
          responded("tc2", "ap2", false, USER_DENIED_REASON),
        ],
      };
      expect(turn.messages.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"]);
      expect(turn.messages.at(-1)).toEqual(reply);
      expect(turn.message).toBeUndefined();
      expect(turn.parentId).toBe("a2");
      expect(turn.answered).toEqual([reply]);
    });

    it.each([
      ["a reply that is not the Active leaf", {}, "a1", BOTH],
      ["a user message", { activeLeafId: "u2" }, "u2", BOTH],
      ["a message not in the Chat", {}, "nope", BOTH],
      [
        "an unknown approval",
        {},
        "a2",
        [...BOTH, { approvalId: "ap9", approved: true }],
      ],
      ["an approval left unanswered", {}, "a2", BOTH.slice(0, 1)],
    ])("409s %s", async (_, leaf, messageId, responses) => {
      seedDb({ chat_message: waiting() });

      await expect(
        resolveTurn({
          chatId: "chat-1",
          owned: true,
          activeLeafId: "a2",
          ...leaf,
          request: respond(responses, messageId),
        }),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("409s a deleted reply", async () => {
      const rows = waiting();
      rows[3].deletedAt = at(9);
      seedDb({ chat_message: rows });

      await expect(
        resolveTurn({
          chatId: "chat-1",
          owned: true,
          activeLeafId: "a2",
          request: respond(BOTH),
        }),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("denies what a new message leaves unanswered, for the model and for the record", async () => {
      seedDb({ chat_message: waiting() });

      const turn = await resolveTurn({
        chatId: "chat-1",
        owned: true,
        request: submit(),
      });

      const reply = {
        id: "a2",
        role: "assistant",
        parts: [
          text("a2"),
          responded("tc1", "ap1", false, MOVED_ON_REASON),
          responded("tc2", "ap2", false, MOVED_ON_REASON),
        ],
      };
      expect(turn.messages.at(-2)).toEqual(reply);
      expect(turn.answered).toEqual([reply]);
    });

    it("lets a waiting reply regenerate, leaving it as it was", async () => {
      seedDb({ chat_message: waiting() });

      const turn = await resolveTurn({
        chatId: "chat-1",
        owned: true,
        request: { trigger: "regenerate-message", messageId: "a2" },
      });

      expect(turn.messages.map((m) => m.id)).toEqual(["u1", "a1", "u2"]);
      expect(turn.answered).toEqual([]);
    });
  });

  describe("deleteMessage", () => {
    it("marks the message deleted and leaves the tree alone", async () => {
      const fake = seedDb({ chat_message: tree() });

      await deleteMessage("chat-1", "u2");

      const u2 = fake.tables.chat_message.find((r) => r.id === "u2");
      expect(u2?.deletedAt).toBeInstanceOf(Date);
      expect(fake.tables.chat_message).toHaveLength(5);
    });

    it("is idempotent, keeping the first deletion's time", async () => {
      const rows = tree();
      rows[2].deletedAt = at(9);
      const fake = seedDb({ chat_message: rows });

      await deleteMessage("chat-1", "u2");

      const u2 = fake.tables.chat_message.find((r) => r.id === "u2");
      expect(u2?.deletedAt).toEqual(at(9));
    });

    it("404s a message that is not in the Chat", async () => {
      seedDb({ chat_message: tree() });

      await expect(deleteMessage("chat-2", "u2")).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });
});
