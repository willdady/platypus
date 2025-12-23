import { notFound } from "next/navigation";
import { ModeToggle } from "@/components/mode-toggle";
import { CommandMenu } from "@/components/command-menu";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { Kbd } from "@/components/ui/kbd";
import { Search, Home } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { joinUrl } from "@/lib/utils";
import { UserMenu } from "@/components/user-menu";
import { ProtectedRoute } from "@/components/protected-route";

export default async function WorkspaceLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ orgId: string; workspaceId: string }>;
}>) {
  const { orgId, workspaceId } = await params;

  // Use internal URL for SSR, fallback to BACKEND_URL for local dev
  const backendUrl =
    process.env.INTERNAL_BACKEND_URL || process.env.BACKEND_URL || "";
  const response = await fetch(
    joinUrl(backendUrl, `/organisations/${orgId}/workspaces/${workspaceId}`),
  );

  if (response.status === 404) {
    notFound();
  }

  // const workspace: Workspace = await response.json();

  return (
    <ProtectedRoute requireOrgAccess requireWorkspaceAccess>
      <SidebarProvider>
        <AppSidebar orgId={orgId} workspaceId={workspaceId} />
        <SidebarInset>
          <header className="flex justify-between p-2">
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
              <Kbd className="text-sm font-sans">
                <Search className="size-4" /> ⌘K
              </Kbd>
              <ModeToggle />
              <UserMenu />
            </div>
          </header>
          <div className="h-[calc(100vh-2.75rem)] overflow-y-auto">
            {children}
          </div>
          <CommandMenu orgId={orgId} workspaceId={workspaceId} />
        </SidebarInset>
      </SidebarProvider>
    </ProtectedRoute>
  );
}
