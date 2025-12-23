import { WorkspaceSettingsMenu } from "@/components/workspace-settings-menu";
import { SidebarProvider } from "@/components/ui/sidebar";

export default async function WorkspaceSettingsLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ orgId: string; workspaceId: string }>;
}>) {
  const { orgId, workspaceId } = await params;

  return (
    <SidebarProvider>
      <div className="flex justify-center">
        <div className="flex w-4/5 max-w-3xl">
          <div className="w-48 fixed top-7 pt-4">
            <WorkspaceSettingsMenu orgId={orgId} workspaceId={workspaceId} />
          </div>
          <div className="flex-1 p-2 ml-48 pb-8">{children}</div>
        </div>
      </div>
    </SidebarProvider>
  );
}
