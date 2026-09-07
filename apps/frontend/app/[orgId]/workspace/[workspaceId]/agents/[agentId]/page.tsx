import { AgentForm } from "@/components/agent-form";
import { headers } from "next/headers";
import { ResourcePage } from "@/components/resource-page";
import { fetchToolSets } from "@/lib/tool-sets-request";

const AgentEditPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; agentId: string }>;
}) => {
  const { orgId, workspaceId, agentId } = await params;

  // Fetch tool sets from the server. A failed read is reported to the form
  // rather than thrown, so the page still renders (issue #818).
  const headersList = await headers();
  const toolSetsResult = await fetchToolSets(
    `/organizations/${orgId}/workspaces/${workspaceId}/tools`,
    headersList.get("cookie") || "",
  );

  return (
    <ResourcePage
      backFallbackHref={`/${orgId}/workspace/${workspaceId}`}
      title="Edit Agent"
      variant="create"
    >
      <AgentForm
        orgId={orgId}
        workspaceId={workspaceId}
        agentId={agentId}
        toolSets={toolSetsResult.ok ? toolSetsResult.toolSets : []}
        toolSetsError={toolSetsResult.ok ? undefined : toolSetsResult.reason}
      />
    </ResourcePage>
  );
};

export default AgentEditPage;
