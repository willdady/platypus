import { ProtectedRoute } from "@/components/protected-route";
import { WorkspaceSettingsMenu } from "@/components/workspace-settings-menu";

export default async function WorkspaceSettingsLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ orgId: string; workspaceId: string }>;
}>) {
  const { orgId, workspaceId } = await params;

  return (
    <ProtectedRoute requireWorkspaceAccess={true} requiredWorkspaceRole="admin">
      <div className="flex justify-center">
        <div className="flex flex-col md:flex-row w-full sm:w-full lg:w-4/5 max-w-3xl py-8 px-4 md:px-0">
          <div className="w-full md:w-48 md:fixed md:top-16 pt-4 mb-8 md:mb-0">
            <WorkspaceSettingsMenu orgId={orgId} workspaceId={workspaceId} />
          </div>
          <div className="flex-1 p-2 md:ml-48 pb-8 min-w-0">{children}</div>
        </div>
      </div>
    </ProtectedRoute>
  );
}
