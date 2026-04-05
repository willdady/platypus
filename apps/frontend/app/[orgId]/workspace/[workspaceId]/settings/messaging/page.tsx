import { MessagingChannelsList } from "@/components/messaging-channels-list";

const MessagingPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = await params;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Messaging</h1>
      <MessagingChannelsList orgId={orgId} workspaceId={workspaceId} />
    </div>
  );
};

export default MessagingPage;
