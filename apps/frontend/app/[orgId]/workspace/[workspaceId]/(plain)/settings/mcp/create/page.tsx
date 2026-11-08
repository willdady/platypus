import type { Metadata } from "next";
import { McpForm } from "@/components/mcp-form";
import { ResourcePage } from "@/components/resource-page";

export const metadata: Metadata = { title: "Add MCP Server" };

async function McpCreatePage({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) {
  const { orgId, workspaceId } = await params;

  return (
    <ResourcePage title="Add MCP Server">
      <McpForm orgId={orgId} workspaceId={workspaceId} />
    </ResourcePage>
  );
}

export default McpCreatePage;
