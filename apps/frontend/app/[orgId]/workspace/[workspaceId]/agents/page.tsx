import { AgentForm } from "@/components/agent-form";
import { type Tool, type Model } from "@agent-kit/schemas";

const Agents = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = await params;

  // Fetch tools and models data on the server
  const [toolsResponse, modelsResponse] = await Promise.all([
    fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/tools`),
    fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/models`),
  ]);

  const toolsData = await toolsResponse.json();
  const modelsData = await modelsResponse.json();

  const tools: Tool[] = toolsData.results;
  const models: Model[] = modelsData.results;

  return (
    <div className="flex justify-center">
      <AgentForm
        classNames="xl:w-2/5"
        orgId={orgId}
        workspaceId={workspaceId}
        tools={tools}
        models={models}
      />
    </div>
  );
};

export default Agents;
