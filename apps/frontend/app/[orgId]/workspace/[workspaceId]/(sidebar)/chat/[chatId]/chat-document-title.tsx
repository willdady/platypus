"use client";

import { useMemo } from "react";
import type { Chat } from "@platypus/schemas";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { useWorkspace } from "@/hooks/use-workspace";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { optionalFetcher } from "@/lib/utils";

/**
 * Titles the tab after the Chat. A new Chat is named only after its first
 * turn, so this follows the row `Chat` already reads and polls (same key, one
 * request) rather than a title fixed on the server. The Workspace row is read
 * here too, not awaited by the page: a server await suspends every navigation
 * into a Chat, flashing a skeleton over a new Chat's centred composer.
 */
export function ChatDocumentTitle({
  orgId,
  workspaceId,
  chatId,
}: {
  orgId: string;
  workspaceId: string;
  chatId: string;
}) {
  const scope = useMemo(() => ({ orgId, workspaceId }), [orgId, workspaceId]);
  const { data: chat } = useScopedSWR<Chat | null>(`chat/${chatId}`, scope, {
    fetcher: optionalFetcher,
  });
  const { data: workspace } = useWorkspace(orgId, workspaceId);
  useDocumentTitle(chat?.title, workspace?.name);
  return null;
}
