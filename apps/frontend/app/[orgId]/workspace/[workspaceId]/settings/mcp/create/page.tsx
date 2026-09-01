import { McpForm } from "@/components/mcp-form";
import { ResourcePage } from "@/components/resource-page";

const McpCreatePage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = await params;

  return (
    <ResourcePage
      backFallbackHref={`/${orgId}/workspace/${workspaceId}/settings/mcp`}
      title="Create MCP"
    >
      <McpForm orgId={orgId} workspaceId={workspaceId} />
    </ResourcePage>
  );
};

export default McpCreatePage;
