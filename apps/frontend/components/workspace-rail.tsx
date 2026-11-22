"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  workspaceNavItems,
  workspaceSection,
} from "@/components/workspace-nav";
import { workspaceRoutes } from "@/lib/routes";

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
  const current = workspaceSection(pathname, routes.root);

  return (
    <nav
      aria-label="Workspace"
      className="fixed inset-y-0 left-0 z-20 hidden w-12 flex-col items-center gap-1 border-r bg-background py-2 md:flex"
    >
      {workspaceNavItems(orgId, workspaceId).map(
        ({ section, label, href, icon: Icon }) => (
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
        ),
      )}
    </nav>
  );
}
