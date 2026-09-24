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
        MCP servers defined here are shared resources. They appear in a
        workspace only where an admin attaches them, and are edited only here.
      </p>
      <McpList orgId={orgId} />
    </div>
  );
};

export default OrgMcpPage;
