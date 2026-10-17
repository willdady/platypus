import type { Metadata } from "next";
import { AgentForm } from "@/components/agent-form";
import { ResourcePage } from "@/components/resource-page";
import { fetchToolSets, toolSetFormProps } from "@/lib/tool-sets-request";
import { backendPath } from "@/lib/server-read";
import { workspaceRoutes } from "@/lib/routes";

export const metadata: Metadata = { title: "Create Agent" };

const AgentCreatePage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = await params;

  // Fetch tool sets from the server. A failed read is reported to the form
  // rather than thrown, so the page still renders (issue #818).
  const toolSetsResult = await fetchToolSets(
    backendPath`/organizations/${orgId}/workspaces/${workspaceId}/tools`,
  );

  return (
    <ResourcePage
      backFallbackHref={workspaceRoutes(orgId, workspaceId).root}
      title="Create Agent"
      variant="narrow"
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
