"use client";

import { usePathname } from "next/navigation";
import { BackButton } from "@/components/back-button";
import { workspaceRoutes } from "@/lib/routes";

/**
 * The header's Back on a Workspace screen without the app sidebar. A Board,
 * its create form and its settings belong to the Boards area, so a direct
 * link — no history to step back through — lands on the Boards list rather
 * than the Workspace home. Everywhere else still falls back to the home.
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
  const inBoards =
    pathname === routes.boards.root ||
    pathname.startsWith(`${routes.boards.root}/`);

  return (
    <BackButton
      variant="header"
      fallbackHref={inBoards ? routes.boards.root : routes.root}
    />
  );
}
