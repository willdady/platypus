import { CommandMenu } from "@/components/command-menu";
import { WorkspaceScrollContainer } from "@/components/workspace-scroll-container";
import { WorkspaceShell } from "@/components/workspace-shell";

/** Every Workspace screen but home and Chat: full width, Back in the header. */
export default async function WorkspacePlainLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ orgId: string; workspaceId: string }>;
}>) {
  const { orgId, workspaceId } = await params;

  return (
    <WorkspaceShell orgId={orgId} workspaceId={workspaceId}>
      <WorkspaceScrollContainer>{children}</WorkspaceScrollContainer>
      <CommandMenu orgId={orgId} workspaceId={workspaceId} />
    </WorkspaceShell>
  );
}
