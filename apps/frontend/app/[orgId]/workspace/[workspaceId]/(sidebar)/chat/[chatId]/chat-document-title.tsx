"use client";

import { useMemo } from "react";
import type { Chat } from "@platypus/schemas";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { optionalFetcher } from "@/lib/utils";

/**
 * Titles the tab after the Chat. A new Chat is named only after its first
 * turn, so this follows the row `Chat` already reads and polls (same key, one
 * request) rather than a title fixed on the server.
 */
export function ChatDocumentTitle({
  orgId,
  workspaceId,
  chatId,
  workspaceName,
}: {
  orgId: string;
  workspaceId: string;
  chatId: string;
  workspaceName?: string;
}) {
  const scope = useMemo(() => ({ orgId, workspaceId }), [orgId, workspaceId]);
  const { data: chat } = useScopedSWR<Chat | null>(`chat/${chatId}`, scope, {
    fetcher: optionalFetcher,
  });
  useDocumentTitle(chat?.title, workspaceName);
  return null;
}
