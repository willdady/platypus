import { UNTITLED_CHAT_TITLE, type ChatListItem } from "@platypus/schemas";
import type { Serialized } from "./api-write";

/**
 * When the sidebar's chat list has to re-read itself (issue #853).
 *
 * The list is the sidebar's own SWR cache, and a chat row is created
 * server-side when its first run starts — after the list was last fetched. So
 * a brand-new chat is invisible until something asks for the list again, and
 * the only thing that used to ask was the open chat announcing its title
 * transition. Navigate away mid-stream, or let titling fail, and the row never
 * showed up at all.
 *
 * {@link chatListPoll} is the whole decision, taken as one: it answers how long
 * until the next read and which chats are still being waited on, because the
 * second feeds the first. All three reasons to poll clear themselves, so the
 * steady state — every chat terminal and titled, nothing being waited on —
 * issues no repeating request:
 *
 * - **A chat is running.** The per-chat spinner is rendered off this list and
 *   nothing else tells it a run ended.
 * - **A chat we expect is missing.** Opening a chat route puts its id in the
 *   URL before the row exists, so "the route names a chat the list has never
 *   heard of" is the signal that one is on its way. It is remembered rather
 *   than re-read off the route each time, because the user may leave before
 *   the row lands — and given up on after {@link MISSING_CHAT_WATCH_MS},
 *   because a chat page opened and never sent from creates no row at all.
 * - **A recent chat is still "Untitled".** Titling is fire-and-forget after
 *   the run reaches a terminal state, so the title lands after the poll for
 *   `running` has already stopped. Bounded by {@link UNTITLED_CHAT_WATCH_MS}
 *   off the row's own `updatedAt`, so a chat whose titling failed settles as
 *   "Untitled" instead of polling forever.
 */

/** How often the sidebar re-reads the chat list while something is pending. */
export const CHAT_LIST_POLL_INTERVAL_MS = 3_000;

/** How long to keep expecting a chat row that the list has not produced yet. */
export const MISSING_CHAT_WATCH_MS = 60_000;

/** How long to keep expecting a generated title for a recently updated chat. */
export const UNTITLED_CHAT_WATCH_MS = 60_000;

/** The part of a listed chat these decisions read. */
export type ListedChat = Pick<
  Serialized<ChatListItem>,
  "id" | "status" | "title" | "updatedAt"
>;

/** A chat whose row the sidebar is waiting on, and when it started waiting. */
export type WatchedChat = {
  id: string;
  since: number;
};

/**
 * The chat the current route is showing, if any.
 *
 * Returns null off a chat route, and for a chat under some other workspace —
 * that chat belongs to a different list than the one being polled.
 */
export const activeChatIdFromPathname = (
  pathname: string,
  orgId: string | undefined,
  workspaceId: string | undefined,
): string | null => {
  if (!orgId || !workspaceId) return null;
  const segments = pathname.split("/").filter(Boolean);
  const [routeOrgId, workspaceLiteral, routeWorkspaceId, chatLiteral, chatId] =
    segments;
  if (routeOrgId !== orgId || workspaceLiteral !== "workspace") return null;
  if (routeWorkspaceId !== workspaceId || chatLiteral !== "chat") return null;
  return chatId ?? null;
};

/**
 * The chats still worth waiting for, given what the list just returned.
 *
 * A watch ends when the chat arrives, and is given up on once it has been
 * waited out — but the entry stays while that chat is the one on screen, so
 * the route cannot keep renewing a watch it has already exhausted. Leaving
 * that chat discards the exhausted entry; coming back starts a fresh watch.
 */
const watchedAfterFetch = ({
  watched,
  listedIds,
  activeChatId,
  now,
}: {
  watched: WatchedChat[];
  listedIds: Set<string>;
  activeChatId: string | null;
  now: number;
}): WatchedChat[] => {
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
};

/** Whether a chat is recent enough that its generated title may still land. */
const isAwaitingTitle = (chat: ListedChat, now: number): boolean => {
  if (chat.title !== UNTITLED_CHAT_TITLE) return false;
  const updatedAt = new Date(chat.updatedAt).getTime();
  if (Number.isNaN(updatedAt)) return false;
  return now - updatedAt <= UNTITLED_CHAT_WATCH_MS;
};

/**
 * What the sidebar should do next about its chat list.
 *
 * `listed` is undefined until the first fetch lands; nothing is polled for
 * before then, though the route's chat is already worth watching.
 *
 * A search filters the list server-side, so an absence from it proves nothing:
 * while one is active the watches are carried untouched rather than dropped
 * (the chat being waited on is still on its way) and they do not call for a
 * poll of their own.
 */
export const chatListPoll = ({
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
}): { watched: WatchedChat[]; intervalMs: number } => {
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
};
