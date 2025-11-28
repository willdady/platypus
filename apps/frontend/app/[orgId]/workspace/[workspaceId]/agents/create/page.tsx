import { AgentForm } from "@/components/agent-form";
import { type ToolSet } from "@agent-kit/schemas";

const AgentCreatePage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = await params;

  // Fetch tool sets from the server
  const [toolSetsResponse] = await Promise.all([
    fetch(`${process.env.BACKEND_URL}/tools`),
  ]);

  const toolSetsData = await toolSetsResponse.json();

  const toolSets: ToolSet[] = toolSetsData.results;

  return (
    <div className="flex justify-center">
      <AgentForm
        classNames="xl:w-2/5"
        orgId={orgId}
        workspaceId={workspaceId}
        toolSets={toolSets}
      />
    </div>
  );
};

export default AgentCreatePage;
