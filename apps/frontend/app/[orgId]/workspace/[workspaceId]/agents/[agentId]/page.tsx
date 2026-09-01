import { AgentForm } from "@/components/agent-form";
import { headers } from "next/headers";
import { ResourcePage } from "@/components/resource-page";
import { type ToolSet } from "@platypus/schemas";
import { joinUrl } from "@/lib/utils";

const AgentEditPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; agentId: string }>;
}) => {
  const { orgId, workspaceId, agentId } = await params;

  // Use internal URL for SSR, fallback to BACKEND_URL for local dev
  const backendUrl =
    process.env.INTERNAL_BACKEND_URL || process.env.BACKEND_URL;

  // Fetch tool sets from the server
  const headersList = await headers();
  const [toolSetsResponse] = await Promise.all([
    fetch(
      joinUrl(
        backendUrl || "",
        `/organizations/${orgId}/workspaces/${workspaceId}/tools`,
      ),
      {
        headers: {
          cookie: headersList.get("cookie") || "",
        },
      },
    ),
  ]);

  const toolSetsData = await toolSetsResponse.json();
  const toolSets: ToolSet[] = toolSetsData.results;

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
        toolSets={toolSets}
      />
    </ResourcePage>
  );
};

export default AgentEditPage;
