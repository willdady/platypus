import { Chat } from "@/components/chat";
import { Model } from "@agent-kit/schemas";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL;

const ChatPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = await params;

  const response = await fetch(`${BACKEND_URL}/models`);
  if (!response.ok) {
    throw new Error("Failed to fetch models");
  }
  const data = await response.json();
  if (data.results.length === 0) {
    throw new Error("No models available");
  }
  const models: Model[] = data.results;
  const initialModelId = models[0].id;

  return <Chat orgId={orgId} workspaceId={workspaceId} models={models} initialModelId={initialModelId} />;
};

export default ChatPage;
