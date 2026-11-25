import { isToolUIPart, type PrepareSendMessagesRequest } from "ai";
import type { PlatypusUIMessage } from "@platypus/schemas";

export function prepareChatTurnRequest({
  messages,
  body,
  trigger,
  messageId,
}: Parameters<PrepareSendMessagesRequest<PlatypusUIMessage>>[0]): {
  body: Record<string, unknown>;
} {
  const { parentId = messages.at(-2)?.id ?? null, ...rest } = (body ?? {}) as {
    parentId?: string | null;
  };
  const last = messages.at(-1);
  if (last?.role === "assistant") {
    return {
      body: {
        ...rest,
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
      ...(trigger === "regenerate-message"
        ? { trigger, messageId }
        : {
            trigger: "submit",
            message: messages.at(-1),
            parentId,
          }),
    },
  };
}
