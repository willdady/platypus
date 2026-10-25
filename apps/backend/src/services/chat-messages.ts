import { isToolUIPart, validateUIMessages } from "ai";
import { sandboxUploadSchema } from "@platypus/schemas";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../index.ts";
import { chat, chatMessage } from "../db/schema.ts";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import type { PlatypusUIMessage } from "../types.ts";
import { errorMessage } from "../utils/error-message.ts";

/**
 * A Chat's messages as the rows the server owns (ADR-0026): a tree through
 * `parentId`, read as the one path a reader sees and a turn continues.
 */

/** A live message's place in the tree. */
export type ChatTreeNode = { id: string; parentId: string | null };

/** A path through a Chat's tree, and every live message's place in it. */
export type ActivePath = {
  messages: PlatypusUIMessage[];
  tree: ChatTreeNode[];
};

/**
 * The shape of a Chat's whole tree, oldest first, without any content: a
 * Chat's Alternatives can be long, and nothing reads them.
 */
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

/**
 * The path ending at `leafId` — the Active path when that is the Chat's
 * `activeLeafId` — plus every live message's place in the tree, oldest first.
 *
 * Walks from the leaf up through `parentId`. A deleted row is left out of the
 * path but still links the messages under it to the ones above, which is what
 * lets Delete take one message out of the middle.
 */
export const loadActivePath = async (
  chatId: string,
  leafId: string | null,
): Promise<ActivePath> => pathThrough(chatId, await loadTree(chatId), leafId);

/** `loadActivePath` over a tree already loaded: reads only the path's content. */
const pathThrough = async (
  chatId: string,
  nodes: Awaited<ReturnType<typeof loadTree>>,
  leafId: string | null,
): Promise<ActivePath> => {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const pathIds: string[] = [];
  for (
    let node = leafId ? byId.get(leafId) : undefined;
    node;
    node = node.parentId ? byId.get(node.parentId) : undefined
  ) {
    if (!node.deletedAt) pathIds.unshift(node.id);
  }

  const rows = pathIds.length
    ? await db
        .select({
          id: chatMessage.id,
          role: chatMessage.role,
          parts: chatMessage.parts,
          metadata: chatMessage.metadata,
        })
        .from(chatMessage)
        .where(
          and(eq(chatMessage.chatId, chatId), inArray(chatMessage.id, pathIds)),
        )
    : [];
  const rowById = new Map(rows.map((row) => [row.id, row]));

  return {
    messages: pathIds.map((id) => {
      const row = rowById.get(id);
      if (!row) throw new Error(`Message '${id}' on the path was not read`);
      const { metadata, ...message } = row;
      // Absent rather than null, the shape a streamed message has.
      return metadata == null ? message : { ...message, metadata };
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

/** What a `POST /chat` asks for, beside the turn's generation settings. */
export type TurnTarget =
  | {
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
  /** What the turn continues, from the server's rows, never the client's. */
  messages: PlatypusUIMessage[];
  /** The user message this turn adds, absent on a regenerate or a resume. */
  message?: PlatypusUIMessage;
  /** The row the turn's new messages hang from, or the reply it resumes. */
  parentId: string | null;
  /**
   * Stored messages on the path whose tool approvals this turn answers, as
   * they now read. Written with the turn's claim, so they are never answered
   * by a turn that did not run.
   */
  answered: PlatypusUIMessage[];
};

/** The reason a call the User denied reaches the model with. */
export const USER_DENIED_REASON = "The User denied this call.";

/** The reason a call left unanswered under a newer message reaches it with. */
export const MOVED_ON_REASON =
  "The User sent a new message instead of answering this approval request, so the call was not run.";

/** The approval ids a message is still waiting on. */
const pendingApprovalIds = (message: PlatypusUIMessage): string[] =>
  message.parts.flatMap((part) =>
    isToolUIPart(part) && part.state === "approval-requested"
      ? [part.approval.id]
      : [],
  );

/** `message` with each approval it waits on answered as `answer` says. */
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

/**
 * The path with every approval still waiting denied: the User moved on
 * without answering. Without the denial the SDK leaves the call out of the
 * model's view altogether, as if it had never been made.
 */
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

/**
 * Works out what a turn continues from, refusing one that cannot run before
 * anything is written.
 *
 * - **Submit** adds the message under `parentId`, which may be deleted: a tab
 *   still showing a message another tab deleted adds its message as an
 *   Alternative on the path it held. Only the path up to that parent is sent
 *   to the model, so a stale tab can never write over a newer path.
 * - **Regenerate** runs again from the reply's parent, which must be a user
 *   message still in the Chat. The old reply stays, as an Alternative.
 * - **Respond to approvals** resumes the reply that stopped to ask, under its
 *   own id. It must be the Chat's Active leaf, and the answers must cover
 *   exactly the approvals it is waiting on.
 *
 * Every approval still waiting elsewhere on the path is denied: the User
 * moved on without answering it.
 *
 * `owned` is whether the Chat exists in this Workspace. A Chat that does not
 * has no messages to hang from or regenerate, whatever holds its id elsewhere.
 */
export const resolveTurn = async ({
  chatId,
  owned,
  activeLeafId = null,
  request,
}: {
  chatId: string;
  owned: boolean;
  /** The Chat's Active leaf, the only reply whose approvals can be answered. */
  activeLeafId?: string | null;
  request: TurnTarget;
}): Promise<ResolvedTurn> => {
  if ("trigger" in request && request.trigger === "respond-to-approvals") {
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
      answered: [...earlier.answered, answered],
    };
  }

  if ("trigger" in request) {
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
    return { ...denyUnanswered(messages), parentId: parent.id };
  }

  // The message is the one thing a client still writes into the Transcript, so
  // it is a trust boundary: the schema has already held it to a user message of
  // text and files, and this holds each part to the shape the SDK converts.
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
    answered: path.answered,
  };
};

/**
 * Moves the Active path onto `messageId`, an Alternative the reader chose, and
 * returns the new path. It lands on the newest message under that one: a
 * message is always newer than the one it follows, so the newest message
 * under it is a leaf. Deleted messages are never landed on, but the walk goes
 * through them, as the Active path does.
 */
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

/**
 * Takes a message out of the Active path for good. The row stays, flagged, so
 * the tree keeps its shape and the messages under it keep their place.
 * Idempotent: deleting it again keeps the first deletion.
 */
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
