import { AgentForm } from "@/components/agent-form";
import { headers } from "next/headers";
import { ResourcePage } from "@/components/resource-page";
import { fetchToolSets, toolSetFormProps } from "@/lib/tool-sets-request";

const OrgAgentEditPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; agentId: string }>;
}) => {
  const { orgId, agentId } = await params;

  // Org-scoped tool sets: static sets + org MCPs (the only ones a Shared agent
  // may reference under the no-cascade rule). A failed read is reported to the
  // form rather than thrown, so the page still renders (issue #818).
  const headersList = await headers();
  const toolSetsResult = await fetchToolSets(
    `/organizations/${orgId}/tools`,
    headersList.get("cookie") || "",
  );

  return (
    <ResourcePage
      backFallbackHref={`/${orgId}/settings/agents`}
      title="Edit Shared Agent"
    >
      <AgentForm
        orgId={orgId}
        agentId={agentId}
        {...toolSetFormProps(toolSetsResult)}
        orgScoped
      />
    </ResourcePage>
  );
};

export default OrgAgentEditPage;
