"use client";

import { useAuth } from "@/components/auth-provider";
import { useRouter } from "next/navigation";
import { LogOut, User } from "lucide-react";
import Link from "next/link";
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
import { userSettingsLinks } from "@/lib/settings-links";

export function UserMenu() {
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
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Account menu"
        >
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
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          My settings
        </DropdownMenuLabel>
        {userSettingsLinks(user.role === "admin").map(
          ({ href, icon: Icon, label }) => (
            <DropdownMenuItem key={href} asChild className="cursor-pointer">
              <Link href={href}>
                <Icon className="size-4" /> {label}
              </Link>
            </DropdownMenuItem>
          ),
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleSignOut} className="cursor-pointer">
          <LogOut className="size-4" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
