import { CommandMenu } from "@/components/command-menu";
import { WorkspaceScrollContainer } from "@/components/workspace-scroll-container";
import { WorkspaceShell } from "@/components/workspace-shell";

/** The Workspace home and Chat: the app sidebar beside the content. */
export default async function WorkspaceSidebarLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ orgId: string; workspaceId: string }>;
}>) {
  const { orgId, workspaceId } = await params;

  return (
    <WorkspaceShell orgId={orgId} workspaceId={workspaceId} sidebar>
      <WorkspaceScrollContainer>{children}</WorkspaceScrollContainer>
      <CommandMenu orgId={orgId} workspaceId={workspaceId} />
    </WorkspaceShell>
  );
}
