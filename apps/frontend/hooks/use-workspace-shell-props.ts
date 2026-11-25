"use client";

import { useParams, usePathname } from "next/navigation";
import { isWorkspaceSidebarRoute } from "@/lib/routes";

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
