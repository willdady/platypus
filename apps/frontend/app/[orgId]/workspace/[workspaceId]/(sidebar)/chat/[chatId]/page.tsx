import type { Metadata } from "next";
import { Chat } from "@/components/chat";
import { ChatDocumentTitle } from "./chat-document-title";

// The Chat's own name is set from the browser, which follows it as it changes.
export const metadata: Metadata = { title: "Chat" };

async function ChatWithIdPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; workspaceId: string; chatId: string }>;
  searchParams: Promise<{ agentId?: string | string[] }>;
}) {
  const { orgId, workspaceId, chatId } = await params;
  const { agentId } = await searchParams;

  return (
    <>
      <ChatDocumentTitle
        orgId={orgId}
        workspaceId={workspaceId}
        chatId={chatId}
      />
      <Chat
        orgId={orgId}
        workspaceId={workspaceId}
        chatId={chatId}
        initialAgentId={
          typeof agentId === "string" && agentId ? agentId : undefined
        }
      />
    </>
  );
}

export default ChatWithIdPage;
