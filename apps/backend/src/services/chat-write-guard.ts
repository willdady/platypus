import { ConflictError } from "../errors.ts";
import type { db, Tx } from "../index.ts";
import { requireOwned } from "./workspace-resource.ts";

const CHAT_READ_ONLY_MESSAGE = "A Trigger run's Chat is read-only";

export const refuseTriggerRunChat = (
  chat: { triggerRunId: string | null } | undefined,
): void => {
  if (chat?.triggerRunId != null)
    throw new ConflictError(CHAT_READ_ONLY_MESSAGE);
};

export const requireWritableChat = async (
  database: typeof db | Tx,
  ref: { id: string; workspaceId: string },
) => {
  const chat = await requireOwned(database, "chat", ref);
  refuseTriggerRunChat(chat);
  return chat;
};
