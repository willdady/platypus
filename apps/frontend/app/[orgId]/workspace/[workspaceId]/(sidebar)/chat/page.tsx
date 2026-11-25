"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useSWRConfig } from "swr";
import { nanoid } from "nanoid";
import { Chat } from "@/components/chat";
import { useBackendUrl } from "@/components/auth-provider";
import { scopedUrl } from "@/lib/api-write";
import { workspaceRoutes } from "@/lib/routes";

function ChatPage() {
  const router = useRouter();
  const { orgId, workspaceId } = useParams<{
    orgId: string;
    workspaceId: string;
  }>();
  const searchParams = useSearchParams();
  const backendUrl = useBackendUrl();
  const { mutate } = useSWRConfig();

  const [chatId] = useState(() => {
    const id = nanoid();
    if (backendUrl) {
      void mutate(
        scopedUrl(backendUrl, `chat/${id}`, { orgId, workspaceId }),
        null,
        { revalidate: false },
      );
    }
    return id;
  });

  useEffect(() => {
    if (!orgId || !workspaceId) return;

    const queryString = searchParams.toString();
    const chatPath = workspaceRoutes(orgId, workspaceId).chat.detail(chatId);
    const redirectUrl = queryString ? `${chatPath}?${queryString}` : chatPath;
    router.replace(redirectUrl);
  }, [orgId, workspaceId, router, searchParams, chatId]);

  return (
    <Chat
      orgId={orgId}
      workspaceId={workspaceId}
      chatId={chatId}
      initialAgentId={searchParams.get("agentId") || undefined}
    />
  );
}

export default ChatPage;
