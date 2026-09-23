"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { nanoid } from "nanoid";
import { Chat } from "@/components/chat";
import { workspaceRoutes } from "@/lib/routes";

const ChatPage = () => {
  const router = useRouter();
  const { orgId, workspaceId } = useParams<{
    orgId: string;
    workspaceId: string;
  }>();
  const searchParams = useSearchParams();
  const [chatId] = useState(nanoid);

  useEffect(() => {
    if (!orgId || !workspaceId) return;

    // Redirect to the chat page for the ID generated above
    const queryString = searchParams.toString();
    const chatPath = workspaceRoutes(orgId, workspaceId).chat.detail(chatId);
    const redirectUrl = queryString ? `${chatPath}?${queryString}` : chatPath;
    router.replace(redirectUrl);
  }, [orgId, workspaceId, router, searchParams, chatId]);

  // Render the chat while the redirect lands, so the composer never blanks
  // (issue #966). The detail page renders the same chat under this ID.
  return (
    <Chat
      orgId={orgId}
      workspaceId={workspaceId}
      chatId={chatId}
      initialAgentId={searchParams.get("agentId") || undefined}
    />
  );
};

export default ChatPage;
