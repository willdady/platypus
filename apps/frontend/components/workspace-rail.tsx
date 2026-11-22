"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FolderOpen, Home, KanbanSquare, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { workspaceRoutes } from "@/lib/routes";

type RailSection = "home" | "boards" | "artifacts";

type RailItem = {
  section: RailSection;
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
function railSection(pathname: string, root: string): RailSection | null {
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

/**
 * The Workspace rail: the leftmost column on every Workspace screen, holding
 * the Workspace's top-level destinations. Icon-only links with a tooltip and
 * an accessible name, so the column stays slim. Drawn from the sidebar's
 * breakpoint up; a phone uses the sheet instead.
 */
export function WorkspaceRail({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) {
  const pathname = usePathname();
  const routes = workspaceRoutes(orgId, workspaceId);
  const current = railSection(pathname, routes.root);

  const items: RailItem[] = [
    {
      section: "home",
      label: "Home",
      href: routes.root,
      icon: Home,
    },
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

  return (
    <nav
      aria-label="Workspace"
      className="fixed inset-y-0 left-0 z-20 hidden w-12 flex-col items-center gap-1 border-r bg-background py-2 md:flex"
    >
      {items.map(({ section, label, href, icon: Icon }) => (
        <Tooltip key={section}>
          <TooltipTrigger asChild>
            <Button
              asChild
              variant="ghost"
              size="icon-sm"
              aria-label={label}
              aria-current={current === section ? "page" : undefined}
              className="aria-[current=page]:bg-accent aria-[current=page]:text-accent-foreground"
            >
              <Link href={href}>
                <Icon />
              </Link>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{label}</TooltipContent>
        </Tooltip>
      ))}
    </nav>
  );
}
