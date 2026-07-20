import { useEffect, useRef } from "react";
import { useSWRConfig } from "swr";
import { UNTITLED_CHAT_TITLE } from "@platypus/schemas";
import { joinUrl } from "@/lib/utils";

/** How often to re-check the chat record for a backend-generated title. */
const POLL_INTERVAL_MS = 3000;
/**
 * Max polls before giving up. Titling runs fire-and-forget on the backend after
 * a run finishes, so this bounds how long the client keeps checking; a manual
 * reload (or the next visit) still surfaces the title once the backend writes it.
 */
const MAX_ATTEMPTS = 10;

/**
 * Bounded polling for a backend-generated chat title.
 *
 * Title/tag generation is now an authoritative backend responsibility that runs
 * after a run reaches a terminal state (see `ChatSink.onFinish`). The client no
 * longer triggers generation — it only discovers the result. While the open
 * chat is still "Untitled" and has a user message, this revalidates the chat
 * record on a short, capped schedule so the generated title appears without a
 * manual reload, then refreshes the sidebar chat list once it lands.
 */
export const useChatTitlePoll = ({
  chatId,
  orgId,
  workspaceId,
  title,
  hasUserMessage,
  backendUrl,
}: {
  chatId: string;
  orgId: string;
  workspaceId: string;
  title: string | undefined;
  hasUserMessage: boolean;
  backendUrl: string;
}) => {
  const { mutate } = useSWRConfig();
  const attemptsRef = useRef(0);
  const prevTitleRef = useRef<string | undefined>(title);

  // Reset the attempt budget when switching chats.
  useEffect(() => {
    attemptsRef.current = 0;
    prevTitleRef.current = undefined;
  }, [chatId]);

  // When the title transitions away from "Untitled", refresh the sidebar chat
  // list so the freshly generated title shows there too (the sidebar keeps its
  // own SWR cache of the list).
  useEffect(() => {
    if (
      backendUrl &&
      title &&
      title !== UNTITLED_CHAT_TITLE &&
      prevTitleRef.current === UNTITLED_CHAT_TITLE
    ) {
      const chatListUrl = joinUrl(
        backendUrl,
        `/organizations/${orgId}/workspaces/${workspaceId}/chat`,
      );
      mutate((key) => typeof key === "string" && key.startsWith(chatListUrl));
    }
    prevTitleRef.current = title;
  }, [title, backendUrl, orgId, workspaceId, mutate]);

  // Poll the chat record while it remains "Untitled".
  useEffect(() => {
    if (!backendUrl || !chatId) return;
    if (title !== UNTITLED_CHAT_TITLE || !hasUserMessage) return;
    if (attemptsRef.current >= MAX_ATTEMPTS) return;

    const chatUrl = joinUrl(
      backendUrl,
      `/organizations/${orgId}/workspaces/${workspaceId}/chat/${chatId}`,
    );
    const interval = setInterval(() => {
      attemptsRef.current += 1;
      void mutate(chatUrl);
      if (attemptsRef.current >= MAX_ATTEMPTS) {
        clearInterval(interval);
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [chatId, title, hasUserMessage, backendUrl, orgId, workspaceId, mutate]);
};
