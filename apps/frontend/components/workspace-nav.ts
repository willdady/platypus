import {
  FileText,
  Home,
  KanbanSquare,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { workspaceRoutes } from "@/lib/routes";

export type WorkspaceSection = "home" | "boards" | "artifacts" | "settings";

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
 * that hang off it — Agents, Skills, Triggers and their runs; Settings for
 * every Workspace settings screen. A Chat belongs to none of them.
 */
export function workspaceSection(
  pathname: string,
  routes: ReturnType<typeof workspaceRoutes>,
): WorkspaceSection | null {
  if (under(pathname, routes.boards.root)) return "boards";
  if (under(pathname, routes.artifacts.root)) return "artifacts";
  if (under(pathname, routes.settings.root)) return "settings";
  if (
    pathname === routes.root ||
    under(pathname, routes.agents.root) ||
    under(pathname, routes.skills.root) ||
    under(pathname, routes.triggers.root) ||
    under(pathname, routes.triggerRuns.root)
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
      icon: FileText,
    },
    {
      section: "settings",
      label: "Workspace settings",
      href: routes.settings.root,
      icon: Settings,
    },
  ];
}
