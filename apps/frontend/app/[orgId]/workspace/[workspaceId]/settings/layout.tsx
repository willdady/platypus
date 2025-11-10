import { SettingsMenu } from "@/components/settings-menu";

export default async function WorkspaceSettingsLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ orgId: string; workspaceId: string }>;
}>) {
  const { orgId, workspaceId } = await params;

  return (
    <div className="flex justify-center">
      <div className="flex w-4/5 max-w-3xl">
        <div className="w-48 fixed top-7 pt-4">
          <SettingsMenu orgId={orgId} workspaceId={workspaceId} />
        </div>
        <div className="flex-1 p-2 ml-48">{children}</div>
      </div>
    </div>
  );
}
