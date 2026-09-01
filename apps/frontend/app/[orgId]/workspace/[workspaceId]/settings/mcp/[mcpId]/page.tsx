import { McpForm } from "@/components/mcp-form";
import { ResourcePage } from "@/components/resource-page";

const McpEditPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; mcpId: string }>;
}) => {
  const { orgId, workspaceId, mcpId } = await params;

  return (
    <ResourcePage
      backFallbackHref={`/${orgId}/workspace/${workspaceId}/settings/mcp`}
      title="Edit MCP"
    >
      <McpForm orgId={orgId} workspaceId={workspaceId} mcpId={mcpId} />
    </ResourcePage>
  );
};

export default McpEditPage;
