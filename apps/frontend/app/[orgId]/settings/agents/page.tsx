import { OrgAgentsList } from "@/components/org-agents-list";

const OrgAgentsPage = async ({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) => {
  const { orgId } = await params;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Organization Agents</h1>
      <p className="text-muted-foreground mb-6">
        Shared agents are promoted from a workspace and run in any workspace
        they are attached to. They are managed here on the organization surface
        and can only be deleted once detached from every workspace.
      </p>
      <OrgAgentsList orgId={orgId} />
    </div>
  );
};

export default OrgAgentsPage;
