import type { Metadata } from "next";
import { OrgAgentsList } from "@/components/org-agents-list";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Organization Agents" };

async function OrgAgentsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  return (
    <div>
      <PageHeader
        title="Organization Agents"
        description="Shared agents are promoted from a workspace and run in any workspace they are attached to. They are managed here on the organization surface and can only be deleted once detached from every workspace."
      />
      <OrgAgentsList orgId={orgId} />
    </div>
  );
}

export default OrgAgentsPage;
