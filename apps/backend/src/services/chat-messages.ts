import { isToolUIPart, validateUIMessages } from "ai";
import { sandboxUploadSchema } from "@platypus/schemas";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../index.ts";
import { chat, chatMessage } from "../db/schema.ts";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import type { PlatypusUIMessage } from "../types.ts";
import { errorMessage } from "../utils/error-message.ts";

export type ChatTreeNode = { id: string; parentId: string | null };

export type StoredChatMessage = PlatypusUIMessage & { createdAt: Date };

export type ActivePath = {
  messages: StoredChatMessage[];
  tree: ChatTreeNode[];
};

const loadTree = (chatId: string) =>
  db
    .select({
      id: chatMessage.id,
      parentId: chatMessage.parentId,
      deletedAt: chatMessage.deletedAt,
      createdAt: chatMessage.createdAt,
    })
    .from(chatMessage)
    .where(eq(chatMessage.chatId, chatId))
    .orderBy(asc(chatMessage.createdAt));

export const loadActivePath = async (
  chatId: string,
  leafId: string | null,
): Promise<ActivePath> => pathThrough(chatId, await loadTree(chatId), leafId);

type ChatTreeRow = Awaited<ReturnType<typeof loadTree>>[number];

const pathThrough = async (
  chatId: string,
  nodes: Awaited<ReturnType<typeof loadTree>>,
  leafId: string | null,
): Promise<ActivePath> => {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const path: ChatTreeRow[] = [];
  for (
    let node = leafId ? byId.get(leafId) : undefined;
    node;
    node = node.parentId ? byId.get(node.parentId) : undefined
  ) {
    if (!node.deletedAt) path.unshift(node);
  }

  const rows = path.length
    ? await db
        .select({
          id: chatMessage.id,
          role: chatMessage.role,
          parts: chatMessage.parts,
          metadata: chatMessage.metadata,
        })
        .from(chatMessage)
        .where(
          and(
            eq(chatMessage.chatId, chatId),
            inArray(
              chatMessage.id,
              path.map((node) => node.id),
            ),
          ),
        )
    : [];
  const rowById = new Map(rows.map((row) => [row.id, row]));

  return {
    messages: path.map((node) => {
      const row = rowById.get(node.id);
      if (!row)
        throw new Error(`Message '${node.id}' on the path was not read`);
      const { metadata, ...message } = row;
      // why: absent rather than null, the shape a streamed message has
      return {
        ...message,
        createdAt: node.createdAt,
        ...(metadata == null ? {} : { metadata }),
      };
    }),
    tree: nodes
      .filter((node) => !node.deletedAt)
      .map(({ id, parentId }) => ({ id, parentId })),
  };
};

const findMessage = async (chatId: string, id: string) => {
  const [row] = await db
    .select({
      id: chatMessage.id,
      parentId: chatMessage.parentId,
      role: chatMessage.role,
      deletedAt: chatMessage.deletedAt,
    })
    .from(chatMessage)
    .where(and(eq(chatMessage.chatId, chatId), eq(chatMessage.id, id)))
    .limit(1);
  return row;
};

export type TurnTarget =
  | {
      trigger: "submit";
      message: { id: string; role: "user"; parts: unknown[] };
      parentId: string | null;
    }
  | { trigger: "regenerate-message"; messageId: string }
  | {
      trigger: "respond-to-approvals";
      messageId: string;
      responses: { approvalId: string; approved: boolean }[];
    };

export type ResolvedTurn = {
  messages: PlatypusUIMessage[];
  message?: PlatypusUIMessage;
  parentId: string | null;
  // why: the id a cancel names this turn by, the user message the run belongs to
  turnId?: string;
  answered: PlatypusUIMessage[];
};

export const USER_DENIED_REASON = "The User denied this call.";

export const MOVED_ON_REASON =
  "The User sent a new message instead of answering this approval request, so the call was not run.";

const pendingApprovalIds = (message: PlatypusUIMessage): string[] =>
  message.parts.flatMap((part) =>
    isToolUIPart(part) && part.state === "approval-requested"
      ? [part.approval.id]
      : [],
  );

export const stillAwaits = (
  stored: PlatypusUIMessage["parts"],
  answered: PlatypusUIMessage,
): boolean => {
  const pending = pendingApprovalIds({ ...answered, parts: stored });
  const responded = new Set(
    answered.parts.flatMap((part) =>
      isToolUIPart(part) && part.state === "approval-responded"
        ? [part.approval.id]
        : [],
    ),
  );
  return pending.length > 0 && pending.every((id) => responded.has(id));
};

const answerApprovals = (
  message: PlatypusUIMessage,
  answer: (approvalId: string) => { approved: boolean; reason?: string },
): PlatypusUIMessage => ({
  ...message,
  parts: message.parts.map((part) =>
    isToolUIPart(part) && part.state === "approval-requested"
      ? {
          ...part,
          state: "approval-responded",
          approval: { ...part.approval, ...answer(part.approval.id) },
        }
      : part,
  ),
});

const denyUnanswered = (
  messages: PlatypusUIMessage[],
): { messages: PlatypusUIMessage[]; answered: PlatypusUIMessage[] } => {
  const answered: PlatypusUIMessage[] = [];
  return {
    messages: messages.map((message) => {
      if (pendingApprovalIds(message).length === 0) return message;
      const denied = answerApprovals(message, () => ({
        approved: false,
        reason: MOVED_ON_REASON,
      }));
      answered.push(denied);
      return denied;
    }),
    answered,
  };
};

export const resolveTurn = async ({
  chatId,
  owned,
  activeLeafId = null,
  request,
}: {
  chatId: string;
  owned: boolean;
  activeLeafId?: string | null;
  request: TurnTarget;
}): Promise<ResolvedTurn> => {
  if (request.trigger === "respond-to-approvals") {
    const target = owned
      ? await findMessage(chatId, request.messageId)
      : undefined;
    if (
      target?.role !== "assistant" ||
      target.deletedAt ||
      target.id !== activeLeafId
    ) {
      throw new ConflictError(
        "Only the Chat's latest reply can have its approvals answered",
      );
    }
    const { messages } = await loadActivePath(chatId, target.id);
    const reply = messages.at(-1);
    if (!reply) throw new Error(`Reply '${target.id}' was not read`);
    const pending = new Set(pendingApprovalIds(reply));
    const answers = new Map(
      request.responses.map((r) => [r.approvalId, r.approved]),
    );
    if (
      answers.size !== pending.size ||
      [...answers.keys()].some((id) => !pending.has(id))
    ) {
      throw new ConflictError(
        "Answer every approval this reply is waiting on, and only those",
      );
    }
    const answered = answerApprovals(reply, (id) =>
      answers.get(id)
        ? { approved: true }
        : { approved: false, reason: USER_DENIED_REASON },
    );
    const earlier = denyUnanswered(messages.slice(0, -1));
    return {
      messages: [...earlier.messages, answered],
      parentId: target.id,
      // why: the id currentTurnId reports while the approved reply is the Chat's leaf
      turnId: target.parentId ?? undefined,
      answered: [...earlier.answered, answered],
    };
  }

  if (request.trigger === "regenerate-message") {
    const target = owned
      ? await findMessage(chatId, request.messageId)
      : undefined;
    if (target?.role !== "assistant" || target.deletedAt) {
      throw new ConflictError("Only a reply still in the Chat can regenerate");
    }
    const parent = target.parentId
      ? await findMessage(chatId, target.parentId)
      : undefined;
    if (parent?.deletedAt) {
      throw new ConflictError(
        "This reply's message is no longer in the Chat, so it cannot regenerate",
      );
    }
    if (parent?.role !== "user") {
      throw new ConflictError(
        "Only a reply to one of your messages can regenerate",
      );
    }
    const { messages } = await loadActivePath(chatId, parent.id);
    return {
      ...denyUnanswered(messages),
      parentId: parent.id,
      turnId: parent.id,
    };
  }

  let message: PlatypusUIMessage | undefined;
  try {
    [message] = await validateUIMessages<PlatypusUIMessage>({
      messages: [request.message],
      dataSchemas: { "sandbox-upload": sandboxUploadSchema },
    });
  } catch (error) {
    throw new ValidationError(errorMessage(error));
  }
  if (!message) throw new Error("validateUIMessages returned no message");

  const { parentId } = request;
  if (parentId !== null && !(owned && (await findMessage(chatId, parentId)))) {
    throw new NotFoundError(`Message '${parentId}' not found`);
  }
  if (owned && (await findMessage(chatId, message.id))) {
    throw new ConflictError(`Message '${message.id}' already exists`);
  }

  const path = denyUnanswered(
    (await loadActivePath(chatId, parentId)).messages,
  );
  return {
    messages: [...path.messages, message],
    message,
    parentId,
    turnId: message.id,
    answered: path.answered,
  };
};

export const switchActivePath = async (
  chatId: string,
  messageId: string,
): Promise<ActivePath> => {
  const nodes = await loadTree(chatId);

  const target = nodes.find((node) => node.id === messageId);
  if (!target || target.deletedAt) {
    throw new NotFoundError(`Message '${messageId}' not found`);
  }

  const childrenOf = Map.groupBy(nodes, (node) => node.parentId);
  let leaf = target;
  const under = [target];
  for (let parent = under.pop(); parent; parent = under.pop()) {
    for (const node of childrenOf.get(parent.id) ?? []) {
      under.push(node);
      if (!node.deletedAt && node.createdAt >= leaf.createdAt) leaf = node;
    }
  }

  await db
    .update(chat)
    .set({ activeLeafId: leaf.id })
    .where(eq(chat.id, chatId));
  return pathThrough(chatId, nodes, leaf.id);
};

export const deleteMessage = async (
  chatId: string,
  messageId: string,
): Promise<void> => {
  if (!(await findMessage(chatId, messageId))) {
    throw new NotFoundError(`Message '${messageId}' not found`);
  }
  await db
    .update(chatMessage)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(chatMessage.chatId, chatId),
        eq(chatMessage.id, messageId),
        isNull(chatMessage.deletedAt),
      ),
    );
};
