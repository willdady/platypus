"use client";

import { useAuth } from "@/components/auth-provider";
import { useRouter } from "next/navigation";
import { LogOut, User, Settings } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { userRoutes, workspaceRoutes } from "@/lib/routes";

interface UserMenuProps {
  orgId?: string;
  workspaceId?: string;
}

export function UserMenu({ orgId, workspaceId }: UserMenuProps) {
  const { user, isPending, authClient } = useAuth();
  const router = useRouter();

  const handleSignOut = async () => {
    await authClient.signOut();
    router.push("/sign-in");
  };

  if (!user) {
    // Hold the trigger's slot while the session resolves: the menu sits last
    // in a right-aligned row, so popping in would shove its neighbours left.
    return isPending ? (
      <Skeleton
        role="status"
        aria-label="Loading account"
        className="size-7 rounded-md"
      />
    ) : null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-7">
          <User className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>
          <div className="flex flex-col space-y-1">
            <p className="text-sm font-medium leading-none">{user.name}</p>
            <p className="text-xs leading-none text-muted-foreground">
              {user.email}
            </p>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => router.push(userRoutes.profile)}
          className="cursor-pointer"
        >
          <Settings className="size-4" /> My settings
        </DropdownMenuItem>
        {orgId && workspaceId && (
          <DropdownMenuItem
            onClick={() =>
              router.push(workspaceRoutes(orgId, workspaceId).settings.root)
            }
            className="cursor-pointer"
          >
            <Settings className="size-4" /> Workspace settings
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleSignOut} className="cursor-pointer">
          <LogOut className="size-4" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
