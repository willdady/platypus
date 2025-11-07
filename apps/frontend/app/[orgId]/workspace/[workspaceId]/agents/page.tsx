import { AgentForm } from "@/components/agent-form";

const Agents = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = await params;

  return (
    <div className="flex justify-center">
      <AgentForm classNames="xl:w-2/5" />
    </div>
  );
};

export default Agents;
