"use client";

import { usePathname } from "next/navigation";
import { BackButton } from "@/components/back-button";
import { workspaceSection } from "@/components/workspace-nav";
import { workspaceRoutes } from "@/lib/routes";

// why: a direct link leaves no history, so a Board falls back to the Boards list
export function WorkspaceBackButton({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) {
  const pathname = usePathname();
  const routes = workspaceRoutes(orgId, workspaceId);
  const section = workspaceSection(pathname, routes);

  if (pathname === routes.boards.root || pathname === routes.artifacts.root) {
    return null;
  }

  const fallbackHref =
    section === "boards"
      ? routes.boards.root
      : section === "artifacts"
        ? routes.artifacts.root
        : routes.root;

  return <BackButton variant="header" fallbackHref={fallbackHref} />;
}
