const WorkspaceSettings = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = await params;

  return (
    <div>
      <h1>Workspace settings: {orgId}/{workspaceId}</h1>
    </div>
  );
};

export default WorkspaceSettings;
