import { UserMenu } from "@/components/user-menu";
import { ModeToggle } from "@/components/mode-toggle";
import { NotificationsDropdown } from "@/components/notifications-dropdown";
import { type Scope } from "@/lib/api-write";

type HeaderProps = {
  leftContent?: React.ReactNode;
  /** Controls rendered before the shared notification/theme/user cluster. */
  rightContent?: React.ReactNode;
  /** The Organization/Workspace the header's controls act on, when there is one. */
  scope?: Scope;
};

export function Header({ leftContent, rightContent, scope }: HeaderProps) {
  return (
    <header className="flex shrink-0 justify-between p-2">
      <div className="flex min-w-0 items-center gap-2">{leftContent}</div>
      <div className="flex shrink-0 items-center gap-2">
        {rightContent}
        <NotificationsDropdown
          orgId={scope?.orgId}
          workspaceId={scope?.workspaceId}
        />
        <ModeToggle />
        <UserMenu />
      </div>
    </header>
  );
}
