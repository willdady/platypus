"use client";

import { appRoutes } from "@/lib/routes";
import { useAuth, useAuthClient } from "@/components/auth-provider";
import { isOperator } from "@/lib/authorization";
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
  const { user, actor, isPending } = useAuth();
  const authClient = useAuthClient();
  const router = useRouter();

  const handleSignOut = async () => {
    await authClient.signOut();
    router.replace(appRoutes.signIn);
  };

  if (!user) {
    // why: hold the slot while the session resolves, or neighbours shove left
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
        <Button variant="ghost" size="icon-xs" aria-label="Account menu">
          <User />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>
          <div className="flex flex-col gap-1">
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
        {userSettingsLinks(isOperator(actor)).map(
          ({ href, icon: Icon, label }) => (
            <DropdownMenuItem key={href} asChild>
              <Link href={href}>
                <Icon className="size-4" /> {label}
              </Link>
            </DropdownMenuItem>
          ),
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleSignOut}>
          <LogOut className="size-4" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
