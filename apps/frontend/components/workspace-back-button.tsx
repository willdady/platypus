"use client";

import { usePathname } from "next/navigation";
import { BackButton } from "@/components/back-button";
import { workspaceRoutes } from "@/lib/routes";

/**
 * The header's Back on a Workspace screen without the app sidebar. The Boards
 * and Artifacts lists are top-level — reached from the rail, not from another
 * screen — so they draw no Back. A deeper screen lights its area and falls
 * back to that area's list when a direct link leaves no history to step
 * through: a Board, its create form and its settings land on the Boards list,
 * an Artifact on the Artifacts list. Everything else falls back to the
 * Workspace home.
 */
export function WorkspaceBackButton({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) {
  const pathname = usePathname();
  const routes = workspaceRoutes(orgId, workspaceId);

  if (pathname === routes.boards.root || pathname === routes.artifacts.root) {
    return null;
  }

  const inArea = (root: string) =>
    pathname === root || pathname.startsWith(`${root}/`);

  const fallbackHref = inArea(routes.boards.root)
    ? routes.boards.root
    : inArea(routes.artifacts.root)
      ? routes.artifacts.root
      : routes.root;

  return <BackButton variant="header" fallbackHref={fallbackHref} />;
}
