"use client";

import { UserMenu } from "@/components/user-menu";
import { ModeToggle } from "@/components/mode-toggle";
import { NotificationsDropdown } from "@/components/notifications-dropdown";

interface HeaderProps {
  leftContent?: React.ReactNode;
  rightContent?: React.ReactNode;
}

export function Header({ leftContent, rightContent }: HeaderProps) {
  return (
    <header className="flex justify-between p-2 border-b">
      <div className="flex items-center gap-2">{leftContent}</div>
      <div className="flex items-center gap-2">
        {rightContent || (
          <>
            <NotificationsDropdown />
            <ModeToggle />
            <UserMenu />
          </>
        )}
      </div>
    </header>
  );
}
