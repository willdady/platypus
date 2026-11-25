import { UNTITLED_CHAT_TITLE, type ChatListItem } from "@platypus/schemas";
import type { Serialized } from "./api-write";

export const CHAT_LIST_POLL_INTERVAL_MS = 3_000;

export const MISSING_CHAT_WATCH_MS = 60_000;

export const UNTITLED_CHAT_WATCH_MS = 60_000;

export type ListedChat = Pick<
  Serialized<ChatListItem>,
  "id" | "status" | "title" | "updatedAt"
>;

export type WatchedChat = {
  id: string;
  since: number;
};

export function activeChatIdFromPathname(
  pathname: string,
  orgId: string | undefined,
  workspaceId: string | undefined,
): string | null {
  if (!orgId || !workspaceId) return null;
  const segments = pathname.split("/").filter(Boolean);
  const [routeOrgId, workspaceLiteral, routeWorkspaceId, chatLiteral, chatId] =
    segments;
  if (routeOrgId !== orgId || workspaceLiteral !== "workspace") return null;
  if (routeWorkspaceId !== workspaceId || chatLiteral !== "chat") return null;
  return chatId ?? null;
}

function watchedAfterFetch({
  watched,
  listedIds,
  activeChatId,
  now,
}: {
  watched: WatchedChat[];
  listedIds: Set<string>;
  activeChatId: string | null;
  now: number;
}): WatchedChat[] {
  const next = watched.filter(
    (entry) =>
      !listedIds.has(entry.id) &&
      (entry.id === activeChatId || now - entry.since <= MISSING_CHAT_WATCH_MS),
  );
  if (
    activeChatId &&
    !listedIds.has(activeChatId) &&
    !next.some((entry) => entry.id === activeChatId)
  ) {
    next.push({ id: activeChatId, since: now });
  }
  return next;
}

function isAwaitingTitle(chat: ListedChat, now: number): boolean {
  if (chat.title !== UNTITLED_CHAT_TITLE) return false;
  const updatedAt = new Date(chat.updatedAt).getTime();
  if (Number.isNaN(updatedAt)) return false;
  return now - updatedAt <= UNTITLED_CHAT_WATCH_MS;
}

export function chatListPoll({
  watched,
  listed,
  activeChatId,
  now,
  isSearching = false,
}: {
  watched: WatchedChat[];
  listed: ListedChat[] | undefined;
  activeChatId: string | null;
  now: number;
  isSearching?: boolean;
}): { watched: WatchedChat[]; intervalMs: number } {
  const listedIds = new Set((listed ?? []).map((chat) => chat.id));
  const nextWatched = isSearching
    ? watched
    : watchedAfterFetch({ watched, listedIds, activeChatId, now });

  if (!listed) return { watched: nextWatched, intervalMs: 0 };

  const pending =
    listed.some((chat) => chat.status === "running") ||
    (!isSearching &&
      nextWatched.some(
        (entry) =>
          !listedIds.has(entry.id) &&
          now - entry.since <= MISSING_CHAT_WATCH_MS,
      )) ||
    listed.some((chat) => isAwaitingTitle(chat, now));

  return {
    watched: nextWatched,
    intervalMs: pending ? CHAT_LIST_POLL_INTERVAL_MS : 0,
  };
}
