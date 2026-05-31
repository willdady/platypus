import { McpList } from "@/components/mcp-list";

const OrgMcpPage = async ({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) => {
  const { orgId } = await params;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Organization MCP Servers</h1>
      <p className="text-muted-foreground mb-6">
        MCP servers defined here are available to agents across all workspaces
        in this organization.
      </p>
      <McpList orgId={orgId} />
    </div>
  );
};

export default OrgMcpPage;
