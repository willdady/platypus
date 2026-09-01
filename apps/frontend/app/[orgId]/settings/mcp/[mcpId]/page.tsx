import { McpForm } from "@/components/mcp-form";
import { ResourcePage } from "@/components/resource-page";

const EditOrgMcpPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; mcpId: string }>;
}) => {
  const { orgId, mcpId } = await params;

  return (
    <ResourcePage
      backFallbackHref={`/${orgId}/settings/mcp`}
      title="Edit Organization MCP"
    >
      <McpForm orgId={orgId} mcpId={mcpId} />
    </ResourcePage>
  );
};

export default EditOrgMcpPage;
