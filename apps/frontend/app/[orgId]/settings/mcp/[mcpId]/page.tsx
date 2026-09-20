import { McpForm } from "@/components/mcp-form";
import { ResourcePage } from "@/components/resource-page";
import { orgRoutes } from "@/lib/routes";

const EditOrgMcpPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; mcpId: string }>;
}) => {
  const { orgId, mcpId } = await params;

  return (
    <ResourcePage
      backFallbackHref={orgRoutes(orgId).settings.mcp}
      title="Edit Organization MCP"
    >
      <McpForm orgId={orgId} mcpId={mcpId} />
    </ResourcePage>
  );
};

export default EditOrgMcpPage;
