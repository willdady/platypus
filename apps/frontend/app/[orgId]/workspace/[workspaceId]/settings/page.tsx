const WorkspaceSettingsPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = await params;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Workspace Settings</h1>
      <div className="space-y-4">
        <div>
          <p className="text-sm text-muted-foreground">Organization ID</p>
          <p className="font-mono">{orgId}</p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">Workspace ID</p>
          <p className="font-mono">{workspaceId}</p>
        </div>
      </div>
    </div>
  );
};

export default WorkspaceSettingsPage;
