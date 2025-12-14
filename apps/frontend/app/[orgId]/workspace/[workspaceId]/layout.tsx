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
import { Search } from "lucide-react";

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
    process.env.INTERNAL_BACKEND_URL || process.env.BACKEND_URL;
  const response = await fetch(`${backendUrl}/workspaces/${workspaceId}`);

  if (response.status === 404) {
    notFound();
  }

  // const workspace: Workspace = await response.json();

  return (
    <SidebarProvider>
      <AppSidebar orgId={orgId} workspaceId={workspaceId} />
      <SidebarInset>
        <header className="flex justify-between p-2">
          <SidebarTrigger className="cursor-pointer" />
          <div className="flex items-center gap-4">
            <Kbd className="text-sm font-sans">
              <Search className="size-4" /> ⌘K
            </Kbd>
            <ModeToggle />
          </div>
        </header>
        <div className="h-[calc(100vh-2.75rem)] overflow-y-auto">
          {children}
        </div>
        <CommandMenu orgId={orgId} workspaceId={workspaceId} />
      </SidebarInset>
    </SidebarProvider>
  );
}
