import { AgentForm } from "@/components/agent-form";

const Agents = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = await params;

  return (
    <div className="flex justify-center">
      <AgentForm
        classNames="xl:w-2/5"
        orgId={orgId}
        workspaceId={workspaceId}
      />
    </div>
  );
};

export default Agents;
