import { UserMenu } from "@/components/user-menu";
import { ModeToggle } from "@/components/mode-toggle";
import { NotificationsDropdown } from "@/components/notifications-dropdown";
import { cn } from "@/lib/utils";
import { type Scope } from "@/lib/api-write";
import { workspaceRoutes } from "@/lib/routes";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Settings } from "lucide-react";
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
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Workspace settings"
                asChild
                className="size-7 cursor-pointer"
              >
                <Link
                  href={
                    workspaceRoutes(scope.orgId, scope.workspaceId).settings
                      .root
                  }
                >
                  <Settings className="size-4" />
                </Link>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Workspace settings</TooltipContent>
          </Tooltip>
        )}
        <UserMenu orgId={scope?.orgId} workspaceId={scope?.workspaceId} />
      </div>
    </header>
  );
}
