import { notFound } from "next/navigation";
import { headers } from "next/headers";
import type { Metadata } from "next";
import { ModeToggle } from "@/components/mode-toggle";
import { NotificationsDropdown } from "@/components/notifications-dropdown";
import { CommandMenu } from "@/components/command-menu";
import { SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { Kbd } from "@/components/ui/kbd";
import { Search, Home } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { joinUrl } from "@/lib/utils";
import { UserMenu } from "@/components/user-menu";
import { ProtectedRoute } from "@/components/protected-route";
import { WorkspaceScrollContainer } from "@/components/workspace-scroll-container";
import type { Workspace } from "@platypus/schemas";

async function fetchWorkspace(
  orgId: string,
  workspaceId: string,
): Promise<{ response: Response; workspace: Workspace | null }> {
  const backendUrl =
    process.env.INTERNAL_BACKEND_URL || process.env.BACKEND_URL || "";
  const headersList = await headers();
  const response = await fetch(
    joinUrl(backendUrl, `/organizations/${orgId}/workspaces/${workspaceId}`),
    {
      headers: {
        cookie: headersList.get("cookie") || "",
      },
    },
  );
  const workspace: Workspace | null = response.ok
    ? await response.json()
    : null;
  return { response, workspace };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}): Promise<Metadata> {
  const { orgId, workspaceId } = await params;
  const { workspace } = await fetchWorkspace(orgId, workspaceId);

  return {
    title: workspace ? `${workspace.name} | Platypus` : "Platypus",
  };
}

export default async function WorkspaceLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ orgId: string; workspaceId: string }>;
}>) {
  const { orgId, workspaceId } = await params;
  const { response } = await fetchWorkspace(orgId, workspaceId);

  if (response.status === 404) {
    notFound();
  }

  return (
    <ProtectedRoute requireOrgAccess requireWorkspaceAccess>
      <SidebarInset className="min-w-0">
        <header className="flex shrink-0 justify-between p-2">
          <div className="flex items-center gap-2">
            <SidebarTrigger className="cursor-pointer" />
            <Button
              variant="ghost"
              size="icon"
              asChild
              className="size-7 cursor-pointer"
            >
              <Link href={`/${orgId}/workspace/${workspaceId}`}>
                <Home />
              </Link>
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Kbd className="hidden text-sm font-sans md:flex">
              <Search className="size-4" /> ⌘K
            </Kbd>
            <NotificationsDropdown orgId={orgId} workspaceId={workspaceId} />
            <ModeToggle />
            <UserMenu orgId={orgId} workspaceId={workspaceId} />
          </div>
        </header>
        <WorkspaceScrollContainer>{children}</WorkspaceScrollContainer>
        <CommandMenu orgId={orgId} workspaceId={workspaceId} />
      </SidebarInset>
    </ProtectedRoute>
  );
}
