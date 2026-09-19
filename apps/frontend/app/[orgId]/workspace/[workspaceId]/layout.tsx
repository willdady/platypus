import { cache } from "react";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import type { Metadata } from "next";
import { CommandMenu } from "@/components/command-menu";
import { SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { Kbd } from "@/components/ui/kbd";
import { Search, Home } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { joinUrl } from "@/lib/utils";
import { Header } from "@/components/header";
import { ProtectedRoute } from "@/components/protected-route";
import { WorkspaceScrollContainer } from "@/components/workspace-scroll-container";
import type { Workspace } from "@platypus/schemas";

// Cached so the metadata and the layout body share one request: both need the
// workspace, and `cache` collapses them into a single backend call.
const fetchWorkspace = cache(async function fetchWorkspace(
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
});

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
        <Header
          bordered={false}
          leftContent={
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
