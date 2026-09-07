import { AgentForm } from "@/components/agent-form";
import { headers } from "next/headers";
import { ResourcePage } from "@/components/resource-page";
import { fetchToolSets, toolSetFormProps } from "@/lib/tool-sets-request";

const AgentCreatePage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = await params;

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
      title="Create Agent"
      variant="create"
    >
      <AgentForm
        orgId={orgId}
        workspaceId={workspaceId}
        {...toolSetFormProps(toolSetsResult)}
      />
    </ResourcePage>
  );
};

export default AgentCreatePage;
