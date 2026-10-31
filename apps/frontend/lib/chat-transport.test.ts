import { describe, it, expect } from "vitest";
import type { PlatypusUIMessage } from "@platypus/schemas";
import { chatMessage as message } from "@/test/chat-test-fixtures";
import { prepareChatTurnRequest } from "./chat-transport";

/**
 * The body one Chat turn puts on the wire (ADR-0026). The server owns the
 * Transcript, so what matters here is what a turn does NOT carry — history —
 * and that each of the three triggers names what it acts on.
 */

const CHAT_ID = "chat-1";

/** One call as the AI SDK makes it, with the parts each test varies. */
function prepare(over: Partial<Parameters<typeof prepareChatTurnRequest>[0]>) {
  return prepareChatTurnRequest({
    id: CHAT_ID,
    messages: [],
    body: { providerId: "p1" },
    requestMetadata: undefined,
    headers: undefined,
    credentials: undefined,
    api: "",
    trigger: "submit-message",
    messageId: undefined,
    ...over,
  });
}

describe("prepareChatTurnRequest", () => {
  it("sends a new message with the id it follows, and no history", () => {
    const next = message("u2", "follow up");

    const { body } = prepare({
      messages: [message("u1", "q"), message("a1", "a"), next],
    });

    expect(body).toEqual({
      providerId: "p1",
      id: CHAT_ID,
      message: next,
      parentId: "a1",
    });
  });

  it("sends a new message under the parent an edit names", () => {
    const { body } = prepare({
      messages: [message("u1", "q"), message("u2-edit", "q2")],
      body: { providerId: "p1", parentId: "a1" },
    });

    expect(body).toEqual({
      providerId: "p1",
      id: CHAT_ID,
      message: message("u2-edit", "q2"),
      parentId: "a1",
    });
  });

  it("sends a Chat's first message as following nothing", () => {
    const { body } = prepare({ messages: [message("u1", "q")] });

    expect(body.parentId).toBeNull();
  });

  it("sends a regenerate as the reply to regenerate, and no message", () => {
    const { body } = prepare({
      messages: [message("u1", "q")],
      trigger: "regenerate-message",
      messageId: "a1",
    });

    expect(body).toEqual({
      providerId: "p1",
      id: CHAT_ID,
      trigger: "regenerate-message",
      messageId: "a1",
    });
  });

  // Issue #1256: the SDK sends the answers by resubmitting the reply itself.
  it("sends a reply's answered approvals as the answers alone", () => {
    const answered = (id: string, approved: boolean) => ({
      type: "dynamic-tool",
      toolName: "db__drop_table",
      toolCallId: `c-${id}`,
      state: "approval-responded",
      input: {},
      approval: { id, approved },
    });
    const reply = {
      ...message("a1", "a"),
      role: "assistant",
      parts: [answered("ap1", true), answered("ap2", false)],
    } as unknown as PlatypusUIMessage;

    const { body } = prepare({
      messages: [message("u1", "q"), reply],
      messageId: "a1",
    });

    expect(body).toEqual({
      providerId: "p1",
      id: CHAT_ID,
      trigger: "respond-to-approvals",
      messageId: "a1",
      responses: [
        { approvalId: "ap1", approved: true },
        { approvalId: "ap2", approved: false },
      ],
    });
  });
});
