"use client";

import { use } from "react";
import { Chat } from "@/components/chat";
import { useSearchParams } from "next/navigation";

const ChatWithIdPage = ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; chatId: string }>;
}) => {
  const { orgId, workspaceId, chatId } = use(params);
  const searchParams = useSearchParams();
  const agentId = searchParams.get("agentId") || undefined;

  return (
    <Chat
      orgId={orgId}
      workspaceId={workspaceId}
      chatId={chatId}
      initialAgentId={agentId}
    />
  );
};

export default ChatWithIdPage;
