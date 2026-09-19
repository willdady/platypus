import { ProtectedRoute } from "@/components/protected-route";
import { WorkspaceSettingsMenu } from "@/components/workspace-settings-menu";
import { SettingsColumns } from "@/components/settings-shell";

export default async function WorkspaceSettingsLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ orgId: string; workspaceId: string }>;
}>) {
  const { orgId, workspaceId } = await params;

  return (
    <ProtectedRoute requireWorkspaceAccess={true}>
      <div className="flex justify-center">
        <SettingsColumns
          menu={
            <WorkspaceSettingsMenu orgId={orgId} workspaceId={workspaceId} />
          }
          columnWidth="narrow"
          contentClassName="p-2 pb-8"
        >
          {children}
        </SettingsColumns>
      </div>
    </ProtectedRoute>
  );
}
