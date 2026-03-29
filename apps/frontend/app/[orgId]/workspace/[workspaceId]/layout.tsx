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
import type { Workspace } from "@platypus/schemas";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}): Promise<Metadata> {
  const { orgId, workspaceId } = await params;

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

  if (!response.ok) {
    return {
      title: "Platypus",
    };
  }

  const workspace: Workspace = await response.json();

  return {
    title: `${workspace.name} | Platypus`,
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

  // Use internal URL for SSR, fallback to BACKEND_URL for local dev
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
            <UserMenu />
          </div>
        </header>
        <div className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden">
          {children}
        </div>
        <CommandMenu orgId={orgId} workspaceId={workspaceId} />
      </SidebarInset>
    </ProtectedRoute>
  );
}
