"use client";

import { useParams, usePathname } from "next/navigation";
import { isWorkspaceSidebarRoute } from "@/lib/routes";

/**
 * The shell props a boundary renders with, read from the route it stands over.
 * The Workspace layout that normally draws the shell hasn't run yet (or threw),
 * so the boundary itself picks the chrome the route is about to land in.
 *
 * `workspaceId` is absent above the Workspace segment itself — the route that
 * redirects to the Organization home.
 */
export function useWorkspaceShellProps() {
  const { orgId, workspaceId } = useParams<{
    orgId: string;
    workspaceId?: string;
  }>();
  const pathname = usePathname();

  return {
    orgId,
    workspaceId,
    sidebar: isWorkspaceSidebarRoute(pathname),
  };
}
