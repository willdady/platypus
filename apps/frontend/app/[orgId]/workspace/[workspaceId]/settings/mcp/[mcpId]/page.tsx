import { McpForm } from "@/components/mcp-form";
import { BackButton } from "@/components/back-button";

const McpEditPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; mcpId: string }>;
}) => {
  const { orgId, workspaceId, mcpId } = await params;

  return (
    <div>
      <BackButton
        fallbackHref={`/${orgId}/workspace/${workspaceId}/settings/mcp`}
      />
      <h1 className="text-2xl mb-4 font-bold">Edit MCP</h1>
      <McpForm orgId={orgId} workspaceId={workspaceId} mcpId={mcpId} />
    </div>
  );
};

export default McpEditPage;
