"use client";

import { useMemo } from "react";
import type { Chat } from "@platypus/schemas";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { useWorkspace } from "@/hooks/use-workspace";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { optionalFetcher } from "@/lib/utils";

// why: a server await would suspend every navigation into a Chat, flashing a skeleton
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
