import type { Metadata } from "next";
import type { Workspace } from "@platypus/schemas";
import { Chat } from "@/components/chat";
import { readForLabel } from "@/lib/server-read";
import { ChatDocumentTitle } from "./chat-document-title";

// The Chat's own name is set from the browser, which follows it as it changes.
export const metadata: Metadata = { title: "Chat" };

const ChatWithIdPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; workspaceId: string; chatId: string }>;
  searchParams: Promise<{ agentId?: string | string[] }>;
}) => {
  const { orgId, workspaceId, chatId } = await params;
  const { agentId } = await searchParams;
  // The Workspace layout reads the same row; Next shares the one request.
  const workspace = await readForLabel<Workspace>(
    `/organizations/${orgId}/workspaces/${workspaceId}`,
  );

  return (
    <>
      <ChatDocumentTitle
        orgId={orgId}
        workspaceId={workspaceId}
        chatId={chatId}
        workspaceName={workspace?.name}
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
};

export default ChatWithIdPage;
