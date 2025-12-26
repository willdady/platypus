import { McpList } from "@/components/mcp-list";

const McpPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = await params;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">MCP Servers</h1>
      <McpList orgId={orgId} workspaceId={workspaceId} />
    </div>
  );
};

export default McpPage;
