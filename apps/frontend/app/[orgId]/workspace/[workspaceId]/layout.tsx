import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { scopedTitle } from "@/lib/page-title";
import { CommandMenu } from "@/components/command-menu";
import { SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { Kbd } from "@/components/ui/kbd";
import { Search, Home } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { backendPath, serverRead } from "@/lib/server-read";
import { Header } from "@/components/header";
import { workspaceRoutes } from "@/lib/routes";
import { ProtectedRoute } from "@/components/protected-route";
import { WorkspaceScrollContainer } from "@/components/workspace-scroll-container";
import type { Workspace } from "@platypus/schemas";

function readWorkspace(orgId: string, workspaceId: string) {
  return serverRead<Workspace>(
    backendPath`/organizations/${orgId}/workspaces/${workspaceId}`,
  );
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}): Promise<Metadata> {
  const { orgId, workspaceId } = await params;
  const workspace = await readWorkspace(orgId, workspaceId);

  return { title: scopedTitle(workspace.ok ? workspace.body.name : undefined) };
}

export default async function WorkspaceLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ orgId: string; workspaceId: string }>;
}>) {
  const { orgId, workspaceId } = await params;
  const workspace = await readWorkspace(orgId, workspaceId);

  if (!workspace.ok && workspace.status === 404) {
    notFound();
  }
  // Any other failure — a timeout included — goes to the error boundary,
  // which offers to try again, rather than rendering the Workspace over a read
  // that failed. A 401 or 403 is left to `ProtectedRoute`, which signs the
  // caller in or says why they are turned away.
  if (!workspace.ok && workspace.status !== 401 && workspace.status !== 403) {
    throw new Error(`Workspace read failed: ${workspace.status}`);
  }

  const routes = workspaceRoutes(orgId, workspaceId);

  return (
    <ProtectedRoute requireWorkspaceAccess>
      <SidebarInset id={MAIN_CONTENT_ID} className="min-w-0">
        <Header
          bordered={false}
          leftContent={
            <div className="flex items-center gap-2">
              <SidebarTrigger />
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Workspace home"
                asChild
              >
                <Link href={routes.root}>
                  <Home />
                </Link>
              </Button>
            </div>
          }
          rightContent={
            <Kbd className="hidden text-sm font-sans md:flex">
              <Search className="size-4" /> ⌘K
            </Kbd>
          }
          scope={{ orgId, workspaceId }}
        />
        <WorkspaceScrollContainer>{children}</WorkspaceScrollContainer>
        <CommandMenu orgId={orgId} workspaceId={workspaceId} />
      </SidebarInset>
    </ProtectedRoute>
  );
}
