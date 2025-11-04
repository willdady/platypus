import { Chat } from "@/components/chat";

const ChatPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = await params;
  return (
    <div className="flex size-full justify-center">
      <div className="h-full w-full xl:w-3/5">
        <Chat orgId={orgId} workspaceId={workspaceId} />
      </div>
    </div>
  );
};

export default ChatPage;