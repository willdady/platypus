import { McpForm } from "@/components/mcp-form";
import { BackButton } from "@/components/back-button";

const EditOrgMcpPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; mcpId: string }>;
}) => {
  const { orgId, mcpId } = await params;

  return (
    <div>
      <BackButton fallbackHref={`/${orgId}/settings/mcp`} />
      <h1 className="text-2xl font-bold mb-4">Edit Organization MCP</h1>
      <McpForm orgId={orgId} mcpId={mcpId} />
    </div>
  );
};

export default EditOrgMcpPage;
