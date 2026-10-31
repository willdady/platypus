import { isToolUIPart, type PrepareSendMessagesRequest } from "ai";
import type { PlatypusUIMessage } from "@platypus/schemas";

/**
 * What one Chat turn puts on the wire (ADR-0026).
 *
 * The server owns the Transcript, so a turn carries only what is new — the
 * message and the id it follows, or the reply to regenerate — and never the
 * Transcript itself. A reply's answered approvals go as the answers alone: the
 * server writes them onto its own rows (issue #1256).
 *
 * Pure and exported so the body shaping is tested directly rather than through
 * a `DefaultChatTransport` nested in the Chat component.
 */
export function prepareChatTurnRequest({
  id,
  messages,
  body,
  trigger,
  messageId,
}: Parameters<PrepareSendMessagesRequest<PlatypusUIMessage>>[0]): {
  body: Record<string, unknown>;
} {
  // An edit names its parent (`useChatTurn`); a composer send follows the last
  // message on screen.
  const { parentId = messages.at(-2)?.id ?? null, ...rest } = (body ?? {}) as {
    parentId?: string | null;
  };
  // Only the SDK's send of a reply's answers ends on an assistant message:
  // every other send ends on the user message it adds.
  const last = messages.at(-1);
  if (last?.role === "assistant") {
    return {
      body: {
        ...rest,
        id,
        trigger: "respond-to-approvals",
        messageId: last.id,
        responses: last.parts.flatMap((part) =>
          isToolUIPart(part) && part.state === "approval-responded"
            ? [
                {
                  approvalId: part.approval.id,
                  approved: part.approval.approved,
                },
              ]
            : [],
        ),
      },
    };
  }
  return {
    body: {
      ...rest,
      id,
      ...(trigger === "regenerate-message"
        ? { trigger, messageId }
        : { message: messages.at(-1), parentId }),
    },
  };
}
