import { ConflictError } from "../errors.ts";
import type { db, Tx } from "../index.ts";
import { requireOwned } from "./workspace-resource.ts";

/**
 * Why a Chat refuses every mutation but cancel: a Trigger run's Chat is the
 * run's own record, so it must stay exactly what the run produced (ADR-0046).
 * Cancel stays open because the Chat's id is the run's id.
 */
const CHAT_READ_ONLY_MESSAGE = "A Trigger run's Chat is read-only";

/**
 * Refuses a mutation of a Chat bound to a Trigger run. `undefined` is a Chat
 * not written yet — a turn's first message — which no run can own.
 */
export const refuseTriggerRunChat = (
  chat: { triggerRunId: string | null } | undefined,
): void => {
  if (chat?.triggerRunId != null)
    throw new ConflictError(CHAT_READ_ONLY_MESSAGE);
};

/**
 * The Chat, refusing it when it belongs to a Trigger run — the one writability
 * check every mutating Chat route shares. A Chat that does not exist (or is
 * outside this Workspace) is still the `NotFoundError` a plain lookup gives.
 */
export const requireWritableChat = async (
  database: typeof db | Tx,
  ref: { id: string; workspaceId: string },
) => {
  const chat = await requireOwned(database, "chat", ref);
  refuseTriggerRunChat(chat);
  return chat;
};
