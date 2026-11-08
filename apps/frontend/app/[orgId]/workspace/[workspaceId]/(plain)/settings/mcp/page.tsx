import type { Metadata } from "next";
import { McpList } from "@/components/mcp-list";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "MCP Servers" };

async function McpPage({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) {
  const { orgId, workspaceId } = await params;

  return (
    <div>
      <PageHeader title="MCP Servers" />
      <McpList orgId={orgId} workspaceId={workspaceId} />
    </div>
  );
}

export default McpPage;
