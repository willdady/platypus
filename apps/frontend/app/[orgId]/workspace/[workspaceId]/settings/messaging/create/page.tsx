import { MessagingChannelForm } from "@/components/messaging-channel-form";
import { BackButton } from "@/components/back-button";

const MessagingCreatePage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = await params;

  return (
    <div>
      <BackButton
        fallbackHref={`/${orgId}/workspace/${workspaceId}/settings/messaging`}
      />
      <h1 className="text-2xl mb-4 font-bold">Add Messaging Channel</h1>
      <MessagingChannelForm orgId={orgId} workspaceId={workspaceId} />
    </div>
  );
};

export default MessagingCreatePage;
