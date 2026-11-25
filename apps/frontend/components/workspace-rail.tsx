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
import { cn } from "@/lib/utils";

export function WorkspaceRail({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) {
  const pathname = usePathname();
  const routes = workspaceRoutes(orgId, workspaceId);
  const current = workspaceSection(pathname, routes);

  return (
    <nav
      aria-label="Workspace"
      className="fixed inset-y-0 left-0 z-20 hidden w-(--workspace-rail-width) flex-col items-center gap-1 border-r bg-rail py-2 md:flex"
    >
      {workspaceNavItems(orgId, workspaceId).map(
        ({ section, label, href, icon: Icon }) => (
          <Tooltip key={section}>
            <TooltipTrigger asChild>
              <Button
                asChild
                variant="ghost"
                size="icon"
                aria-label={label}
                aria-current={current === section ? "page" : undefined}
                className={cn(
                  "aria-[current=page]:bg-sidebar aria-[current=page]:text-foreground",
                  // why: Settings sits apart, at the foot of the rail
                  section === "settings" && "mt-auto",
                )}
              >
                <Link href={href}>
                  <Icon className="size-5" />
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
