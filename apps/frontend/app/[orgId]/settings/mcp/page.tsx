import type { Metadata } from "next";
import { McpList } from "@/components/mcp-list";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Organization MCP Servers" };

async function OrgMcpPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;

  return (
    <div>
      <PageHeader
        title="Organization MCP Servers"
        description="MCP servers defined here are shared resources. They appear in a workspace only where an admin attaches them, and are edited only here."
      />
      <McpList orgId={orgId} />
    </div>
  );
}

export default OrgMcpPage;
