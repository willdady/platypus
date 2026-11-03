import type { Metadata } from "next";
import { McpForm } from "@/components/mcp-form";
import { ResourcePage } from "@/components/resource-page";

export const metadata: Metadata = { title: "Add Organization MCP" };

async function CreateOrgMcpPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  return (
    <ResourcePage title="Add Organization MCP">
      <McpForm orgId={orgId} />
    </ResourcePage>
  );
}

export default CreateOrgMcpPage;
