import { Chat } from "@/components/chat";

const ChatWithIdPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; chatId: string }>;
}) => {
  const { orgId, workspaceId, chatId } = await params;

  return <Chat orgId={orgId} workspaceId={workspaceId} chatId={chatId} />;
};

export default ChatWithIdPage;
