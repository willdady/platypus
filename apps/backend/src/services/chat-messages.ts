import { validateUIMessages } from "ai";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../index.ts";
import { chatMessage } from "../db/schema.ts";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import type { PlatypusUIMessage } from "../types.ts";

/**
 * A Chat's messages as the rows the server owns (ADR-0026): a tree through
 * `parentId`, read as the one path a reader sees and a turn continues.
 */

/** A live message's place in the tree. */
export type ChatTreeNode = { id: string; parentId: string | null };

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
): Promise<{ messages: PlatypusUIMessage[]; tree: ChatTreeNode[] }> => {
  // The whole tree's shape first, then the content of only the path: a Chat's
  // Alternatives can be long, and nothing here reads them.
  const nodes = await db
    .select({
      id: chatMessage.id,
      parentId: chatMessage.parentId,
      deletedAt: chatMessage.deletedAt,
    })
    .from(chatMessage)
    .where(eq(chatMessage.chatId, chatId))
    .orderBy(asc(chatMessage.createdAt));

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
      const { metadata, ...message } = rowById.get(id)!;
      // Absent rather than null, the shape a streamed message has.
      return (
        metadata == null ? message : { ...message, metadata }
      ) as PlatypusUIMessage;
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
  | { trigger: "regenerate-message"; messageId: string };

export type ResolvedTurn = {
  /** What the turn continues, from the server's rows, never the client's. */
  messages: PlatypusUIMessage[];
  /** The user message this turn adds, absent on a regenerate. */
  message?: PlatypusUIMessage;
  /** The row the turn's new messages hang from. */
  parentId: string | null;
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
 *
 * `owned` is whether the Chat exists in this Workspace. A Chat that does not
 * has no messages to hang from or regenerate, whatever holds its id elsewhere.
 */
export const resolveTurn = async ({
  chatId,
  owned,
  request,
}: {
  chatId: string;
  owned: boolean;
  request: TurnTarget;
}): Promise<ResolvedTurn> => {
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
    if (!parent || parent.deletedAt || parent.role !== "user") {
      throw new ConflictError(
        "This reply's message is no longer in the Chat, so it cannot regenerate",
      );
    }
    const { messages } = await loadActivePath(chatId, parent.id);
    return { messages, parentId: parent.id };
  }

  // The message is the one thing a client still writes into the Transcript, so
  // it is a trust boundary: the schema has already held it to a user message of
  // text and files, and this holds each part to the shape the SDK converts.
  let message: PlatypusUIMessage;
  try {
    [message] = await validateUIMessages<PlatypusUIMessage>({
      messages: [request.message],
    });
  } catch (error) {
    throw new ValidationError(
      error instanceof Error ? error.message : String(error),
    );
  }

  const { parentId } = request;
  if (parentId !== null && !(owned && (await findMessage(chatId, parentId)))) {
    throw new NotFoundError(`Message '${parentId}' not found`);
  }
  if (owned && (await findMessage(chatId, message.id))) {
    throw new ConflictError(`Message '${message.id}' already exists`);
  }

  const { messages } = await loadActivePath(chatId, parentId);
  return { messages: [...messages, message], message, parentId };
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
