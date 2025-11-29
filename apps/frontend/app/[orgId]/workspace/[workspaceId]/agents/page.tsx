import { AgentsList } from "@/components/agents-list";

const Agents = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = await params;

  return (
    <div className="flex justify-center px-3">
      <div className="max-w-7xl">
        <AgentsList orgId={orgId} workspaceId={workspaceId} />
      </div>
    </div>
  );
};

export default Agents;
