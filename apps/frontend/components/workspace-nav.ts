import { FolderOpen, Home, KanbanSquare, type LucideIcon } from "lucide-react";
import { workspaceRoutes } from "@/lib/routes";

export type WorkspaceSection = "home" | "boards" | "artifacts";

export type WorkspaceNavItem = {
  section: WorkspaceSection;
  label: string;
  href: string;
  icon: LucideIcon;
};

function under(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Which part of the Workspace a path belongs to. Boards and Artifacts light
 * for anything under their path; Home for the Workspace root and the screens
 * that hang off it — Agents, Skills, Triggers and their runs. A Chat or a
 * settings screen belongs to none of them.
 */
export function workspaceSection(
  pathname: string,
  root: string,
): WorkspaceSection | null {
  if (under(pathname, `${root}/boards`)) return "boards";
  if (under(pathname, `${root}/artifacts`)) return "artifacts";
  if (
    pathname === root ||
    under(pathname, `${root}/agents`) ||
    under(pathname, `${root}/skills`) ||
    under(pathname, `${root}/triggers`) ||
    under(pathname, `${root}/trigger-runs`)
  ) {
    return "home";
  }
  return null;
}

/** The Workspace's top-level destinations, in the order the rail and sheet draw them. */
export function workspaceNavItems(
  orgId: string,
  workspaceId: string,
): WorkspaceNavItem[] {
  const routes = workspaceRoutes(orgId, workspaceId);

  return [
    { section: "home", label: "Home", href: routes.root, icon: Home },
    {
      section: "boards",
      label: "Boards",
      href: routes.boards.root,
      icon: KanbanSquare,
    },
    {
      section: "artifacts",
      label: "Artifacts",
      href: routes.artifacts.root,
      icon: FolderOpen,
    },
  ];
}
