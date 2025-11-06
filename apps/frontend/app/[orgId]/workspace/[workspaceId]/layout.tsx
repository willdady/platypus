import type { Metadata } from "next";
import { ModeToggle } from "@/components/mode-toggle";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";

export default async function WorkspaceLayout({
  children,
  params
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ orgId: string; workspaceId: string }>
}>) {

  const { orgId, workspaceId } = await params;

  return (
    <SidebarProvider>
      <AppSidebar orgId={orgId} workspaceId={workspaceId} />
      <SidebarInset>
        <header className="flex justify-between p-2">
          <SidebarTrigger className="cursor-pointer" />
          <ModeToggle />
        </header>
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
}
