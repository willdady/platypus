import type { Metadata } from "next";
import { McpForm } from "@/components/mcp-form";
import { ResourcePage } from "@/components/resource-page";

export const metadata: Metadata = { title: "Edit MCP" };

async function McpEditPage({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; mcpId: string }>;
}) {
  const { orgId, workspaceId, mcpId } = await params;

  return (
    <ResourcePage title="Edit MCP">
      <McpForm orgId={orgId} workspaceId={workspaceId} mcpId={mcpId} />
    </ResourcePage>
  );
}

export default McpEditPage;
