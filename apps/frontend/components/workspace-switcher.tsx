"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowLeftRight,
  ChevronsUpDown,
  FolderClosed,
  FolderOpen,
  Plus,
  Settings,
} from "lucide-react";
import type { Workspace } from "@platypus/schemas";
import { useAuth } from "@/components/auth-provider";
import { canCreateWorkspace, canOpenOrgSettings } from "@/lib/authorization";
import { sortByName } from "@/lib/utils";
import { useScopedList } from "@/hooks/use-scoped-list";
import { useOrganization } from "@/hooks/use-organization";
import { orgRoutes, workspaceRoutes } from "@/lib/routes";
import { Button } from "@/components/ui/button";
import { SidebarMenuButton } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type SwitcherPresentation = "bar" | "sheet";

type WorkspaceSwitcherProps = {
  orgId: string;
  workspaceId: string;
  /**
   * Where the trigger sits: the one-line button in the top bar, or the stacked
   * form at the top of the mobile sheet.
   */
  presentation: SwitcherPresentation;
  /** Called when a menu item is picked, so a sheet holding the switcher can close. */
  onNavigate?: () => void;
};

/**
 * The Organization/Workspace switcher — one menu, two triggers. The menu lists
 * the Organization's Workspaces, then Add workspace, Switch org and
 * Organization settings, each under the same permission check wherever it is
 * drawn.
 */
export function WorkspaceSwitcher({
  orgId,
  workspaceId,
  presentation,
  onNavigate,
}: WorkspaceSwitcherProps) {
  const pathname = usePathname();
  const { actor } = useAuth();
  const org = orgRoutes(orgId);

  const { results: allWorkspaces, isLoading: isWorkspacesLoading } =
    useScopedList<Workspace>("workspaces", { orgId });
  const { data: orgData, isLoading: isOrgLoading } = useOrganization(orgId);

  const workspaces = sortByName(allWorkspaces);
  const currentWorkspace = workspaces.find((w) => w.id === workspaceId);

  // Placeholders keep each trigger steady until the names land.
  const orgLoading = !orgData && isOrgLoading;
  const workspaceLoading = !currentWorkspace && isWorkspacesLoading;

  const trigger =
    presentation === "bar" ? (
      <Button
        variant="ghost"
        size="sm"
        className="h-7 min-w-0 max-w-[min(24rem,50vw)] gap-1 px-2 font-normal"
      >
        {orgLoading ? (
          <Skeleton
            data-testid="org-name-skeleton"
            className="h-3 w-16 shrink-0"
          />
        ) : (
          <span className="min-w-0 truncate text-muted-foreground">
            {orgData?.name}
          </span>
        )}
        <span className="shrink-0 text-muted-foreground">/</span>
        {workspaceLoading ? (
          <Skeleton
            data-testid="workspace-name-skeleton"
            className="h-3.5 w-20 shrink-0"
          />
        ) : (
          <span className="min-w-0 truncate font-medium">
            {currentWorkspace?.name}
          </span>
        )}
        <ChevronsUpDown className="size-4 shrink-0" />
      </Button>
    ) : (
      <SidebarMenuButton className="h-auto py-2">
        <div className="flex flex-col flex-1 items-start leading-none">
          {orgLoading ? (
            <Skeleton
              data-testid="org-name-skeleton"
              className="mt-0.5 mb-1.5 h-3 w-24"
            />
          ) : (
            <span className="text-xs text-muted-foreground mb-1">
              {orgData?.name}
            </span>
          )}
          <div className="flex items-center gap-2 w-full">
            <FolderOpen className="size-4 shrink-0" />
            {workspaceLoading ? (
              <Skeleton
                data-testid="workspace-name-skeleton"
                className="h-3.5 w-28"
              />
            ) : (
              <span className="font-medium">{currentWorkspace?.name}</span>
            )}
            <ChevronsUpDown className="ml-auto size-4 shrink-0" />
          </div>
        </div>
      </SidebarMenuButton>
    );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        className="w-56 bg-sidebar-panel"
        align="start"
        side="bottom"
      >
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          Workspaces
        </DropdownMenuLabel>
        <DropdownMenuGroup>
          {workspaces.map((workspace) => {
            const href = workspaceRoutes(
              workspace.organizationId,
              workspace.id,
            ).root;
            return (
              <DropdownMenuItem key={workspace.id} asChild>
                <Link href={href} onClick={onNavigate}>
                  {pathname.startsWith(href) ? (
                    <FolderOpen />
                  ) : (
                    <FolderClosed />
                  )}{" "}
                  {workspace.name}
                </Link>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          {/* ADR-0008: Workspace creation is org-admin-only. */}
          {canCreateWorkspace(actor) && (
            <DropdownMenuItem asChild>
              <Link href={org.createWorkspace} onClick={onNavigate}>
                <Plus /> Add workspace
              </Link>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem asChild>
            <Link href={org.root} onClick={onNavigate}>
              <ArrowLeftRight /> Switch org
            </Link>
          </DropdownMenuItem>
          {canOpenOrgSettings(actor) && (
            <DropdownMenuItem asChild>
              <Link href={org.settings.root} onClick={onNavigate}>
                <Settings /> Organization settings
              </Link>
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
