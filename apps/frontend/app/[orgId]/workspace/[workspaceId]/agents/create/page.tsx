import { AgentForm } from "@/components/agent-form";
import { type Tool } from "@agent-kit/schemas";

const AgentCreatePage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = await params;

  // Fetch tools from the server
  const [toolsResponse] = await Promise.all([
    fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/tools`),
  ]);

  const toolsData = await toolsResponse.json();

  const tools: Tool[] = toolsData.results;

  return (
    <div className="flex justify-center">
      <AgentForm
        classNames="xl:w-2/5"
        orgId={orgId}
        workspaceId={workspaceId}
        tools={tools}
      />
    </div>
  );
};

export default AgentCreatePage;
