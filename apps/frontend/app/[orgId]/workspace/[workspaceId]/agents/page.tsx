const Agents = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = await params;
  return (
    <div>
      <h1>Agents: {orgId}/{workspaceId}</h1>
    </div>
  );
};

export default Agents;