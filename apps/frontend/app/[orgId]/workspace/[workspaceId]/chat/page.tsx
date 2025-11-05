import { Chat } from "@/components/chat";

const ChatPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = await params;
  return (
    <div className="flex size-full justify-center">
      <Chat orgId={orgId} workspaceId={workspaceId} />
    </div>
  );
};

export default ChatPage;