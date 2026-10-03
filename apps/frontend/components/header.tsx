import { UserMenu } from "@/components/user-menu";
import { ModeToggle } from "@/components/mode-toggle";
import { NotificationsDropdown } from "@/components/notifications-dropdown";
import { cn } from "@/lib/utils";
import { type Scope } from "@/lib/api-write";
import { workspaceRoutes } from "@/lib/routes";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Box, Info, Radio, Settings, Unplug, Wrench } from "lucide-react";
import Link from "next/link";

interface HeaderProps {
  leftContent?: React.ReactNode;
  /** Controls rendered before the shared notification/theme/user cluster. */
  rightContent?: React.ReactNode;
  /** The Organization/Workspace the header's controls act on, when there is one. */
  scope?: Scope;
  /**
   * Draw the bottom border. The Workspace shell sits beside a sidebar and
   * omits it; every other shell keeps it.
   */
  bordered?: boolean;
}

export function Header({
  leftContent,
  rightContent,
  scope,
  bordered = true,
}: HeaderProps) {
  return (
    <header
      className={cn(
        "flex shrink-0 justify-between p-2",
        bordered && "border-b",
      )}
    >
      <div className="flex items-center gap-2">{leftContent}</div>
      <div className="flex items-center gap-2">
        {rightContent}
        <NotificationsDropdown
          orgId={scope?.orgId}
          workspaceId={scope?.workspaceId}
        />
        <ModeToggle />
        {scope?.workspaceId && (
          <WorkspaceSettingsDropdown
            orgId={scope.orgId}
            workspaceId={scope.workspaceId}
          />
        )}
        <UserMenu />
      </div>
    </header>
  );
}

function WorkspaceSettingsDropdown({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) {
  const routes = workspaceRoutes(orgId, workspaceId).settings;
  const items = [
    { href: routes.root, icon: Settings, label: "Workspace" },
    { href: routes.providers, icon: Unplug, label: "Providers" },
    { href: routes.mcp, icon: Wrench, label: "MCP" },
    { href: routes.sandbox, icon: Box, label: "Sandbox" },
    { href: routes.webhooks, icon: Radio, label: "Webhooks" },
    { href: routes.about, icon: Info, label: "About" },
  ];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Workspace settings"
          className="size-7 cursor-pointer"
        >
          <Settings className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {items.map(({ href, icon: Icon, label }) => (
          <DropdownMenuItem key={href} asChild className="cursor-pointer">
            <Link href={href}>
              <Icon className="size-4" /> {label}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
