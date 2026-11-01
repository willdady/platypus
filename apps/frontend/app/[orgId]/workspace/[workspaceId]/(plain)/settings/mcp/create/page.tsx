import type { Metadata } from "next";
import { McpForm } from "@/components/mcp-form";
import { ResourcePage } from "@/components/resource-page";

export const metadata: Metadata = { title: "Create MCP" };

async function McpCreatePage({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) {
  const { orgId, workspaceId } = await params;

  return (
    <ResourcePage title="Create MCP">
      <McpForm orgId={orgId} workspaceId={workspaceId} />
    </ResourcePage>
  );
}

export default McpCreatePage;
