import type { Metadata } from "next";
import { McpForm } from "@/components/mcp-form";
import { ResourcePage } from "@/components/resource-page";

export const metadata: Metadata = { title: "Edit Organization MCP" };

async function EditOrgMcpPage({
  params,
}: {
  params: Promise<{ orgId: string; mcpId: string }>;
}) {
  const { orgId, mcpId } = await params;

  return (
    <ResourcePage title="Edit Organization MCP">
      <McpForm orgId={orgId} mcpId={mcpId} />
    </ResourcePage>
  );
}

export default EditOrgMcpPage;
