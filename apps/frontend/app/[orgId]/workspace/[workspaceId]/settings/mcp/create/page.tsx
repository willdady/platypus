import type { Metadata } from "next";
import { McpForm } from "@/components/mcp-form";
import { ResourcePage } from "@/components/resource-page";
import { workspaceRoutes } from "@/lib/routes";

export const metadata: Metadata = { title: "Create MCP" };

const McpCreatePage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = await params;

  return (
    <ResourcePage
      backFallbackHref={workspaceRoutes(orgId, workspaceId).settings.mcp}
      title="Create MCP"
    >
      <McpForm orgId={orgId} workspaceId={workspaceId} />
    </ResourcePage>
  );
};

export default McpCreatePage;
