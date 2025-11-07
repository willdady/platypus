const MCP = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = await params;
  return (
    <div>
      <h1>
        MCP: {orgId}/{workspaceId}
      </h1>
    </div>
  );
};

export default MCP;
