import { Chat } from "@/components/chat";

const ChatPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = await params;

  return <Chat orgId={orgId} workspaceId={workspaceId} />;
};

export default ChatPage;
