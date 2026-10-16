import type { Metadata } from "next";
import { McpForm } from "@/components/mcp-form";
import { ResourcePage } from "@/components/resource-page";
import { workspaceRoutes } from "@/lib/routes";

export const metadata: Metadata = { title: "Edit MCP" };

const McpEditPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; mcpId: string }>;
}) => {
  const { orgId, workspaceId, mcpId } = await params;

  return (
    <ResourcePage
      backFallbackHref={workspaceRoutes(orgId, workspaceId).settings.mcp}
      title="Edit MCP"
    >
      <McpForm orgId={orgId} workspaceId={workspaceId} mcpId={mcpId} />
    </ResourcePage>
  );
};

export default McpEditPage;
