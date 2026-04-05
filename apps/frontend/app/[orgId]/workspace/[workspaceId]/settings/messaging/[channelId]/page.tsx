import { MessagingChannelForm } from "@/components/messaging-channel-form";
import { BackButton } from "@/components/back-button";

const MessagingEditPage = async ({
  params,
}: {
  params: Promise<{
    orgId: string;
    workspaceId: string;
    channelId: string;
  }>;
}) => {
  const { orgId, workspaceId, channelId } = await params;

  return (
    <div>
      <BackButton
        fallbackHref={`/${orgId}/workspace/${workspaceId}/settings/messaging`}
      />
      <h1 className="text-2xl mb-4 font-bold">Edit Messaging Channel</h1>
      <MessagingChannelForm
        orgId={orgId}
        workspaceId={workspaceId}
        channelId={channelId}
      />
    </div>
  );
};

export default MessagingEditPage;
