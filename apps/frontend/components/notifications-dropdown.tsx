"use client";

import { Bell, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fetcher, joinUrl } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";
import { type InvitationListItem } from "@platypus/schemas";
import Link from "next/link";
import useSWR from "swr";

export function NotificationsDropdown() {
  const backendUrl = useBackendUrl();
  const { data } = useSWR<{ results: InvitationListItem[] }>(
    joinUrl(backendUrl, "/users/me/invitations"),
    fetcher,
    { refreshInterval: 60000 * 2 } // Refresh every 2 minutes
  );

  const invitations = data?.results || [];
  const count = invitations.length;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative cursor-pointer">
          <Bell className="h-5 w-5" />
          {count > 0 && (
            <span className="absolute -top-0 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-[10px] font-medium text-destructive-foreground">
              {count}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>Notifications</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {count === 0 ? (
          <div className="p-4 text-center text-sm text-muted-foreground">
            No new notifications
          </div>
        ) : (
          <>
            <div className="max-h-80 overflow-y-auto">
              {invitations.map((invite) => (
                <DropdownMenuItem key={invite.id} asChild>
                  <Link
                    href="/settings/invitations"
                    className="flex flex-col items-start gap-1 p-3 cursor-pointer"
                  >
                    <div className="flex items-center gap-2 font-medium">
                      <Mail className="h-4 w-4" />
                      Workspace Invitation
                    </div>
                    <div className="text-xs text-muted-foreground line-clamp-2">
                      You've been invited to join <strong>{invite.workspaceName}</strong> in{" "}
                      <strong>{invite.organisationName}</strong>.
                    </div>
                  </Link>
                </DropdownMenuItem>
              ))}
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link
                href="/settings/invitations"
                className="w-full justify-center text-center font-medium cursor-pointer"
              >
                View all invitations
              </Link>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
