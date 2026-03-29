"use client";

import { useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { Bell, Mail, Bot, ChevronDown, ChevronUp, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { fetcher, joinUrl } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";
import {
  type InvitationListItem,
  type NotificationListItem,
} from "@platypus/schemas";
import Link from "next/link";
import useSWR from "swr";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

function formatRelativeTime(date: Date | string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const diffSeconds = Math.floor((now - then) / 1000);

  if (diffSeconds < 60) return "just now";
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60)
    return `${diffMinutes} min${diffMinutes === 1 ? "" : "s"} ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24)
    return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
  const diffMonths = Math.floor(diffDays / 30);
  return `${diffMonths} month${diffMonths === 1 ? "" : "s"} ago`;
}

interface NotificationsDropdownProps {
  orgId?: string;
  workspaceId?: string;
}

export function NotificationsDropdown({
  orgId,
  workspaceId,
}: NotificationsDropdownProps) {
  const { user } = useAuth();
  const backendUrl = useBackendUrl();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const notificationsUrl =
    backendUrl && user && orgId && workspaceId
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/notifications`,
        )
      : null;

  const unreadCountUrl =
    backendUrl && user && orgId && workspaceId
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/notifications/unread-count`,
        )
      : null;

  const { data: notificationsData, mutate: mutateNotifications } = useSWR<{
    results: NotificationListItem[];
  }>(notificationsUrl, fetcher, { refreshInterval: 30000 });

  const { data: unreadCountData, mutate: mutateUnreadCount } = useSWR<{
    count: number;
  }>(unreadCountUrl, fetcher, { refreshInterval: 30000 });

  const { data: invitationsData } = useSWR<{ results: InvitationListItem[] }>(
    backendUrl && user ? joinUrl(backendUrl, "/users/me/invitations") : null,
    fetcher,
    { refreshInterval: 60000 * 2 },
  );

  const notifications = notificationsData?.results || [];
  const invitations = invitationsData?.results || [];
  const unreadNotificationCount = unreadCountData?.count ?? 0;
  const totalCount = unreadNotificationCount + invitations.length;

  const handleMarkAsRead = async (notificationId: string) => {
    if (!notificationsUrl) return;
    await fetcher(joinUrl(notificationsUrl, `/${notificationId}/read`), {
      method: "POST",
    });
    mutateNotifications();
    mutateUnreadCount();
  };

  const handleMarkAllAsRead = async () => {
    if (!notificationsUrl) return;
    await fetcher(joinUrl(notificationsUrl, "/read-all"), {
      method: "POST",
    });
    mutateNotifications();
    mutateUnreadCount();
  };

  const handleDismiss = async (notificationId: string) => {
    if (!notificationsUrl) return;
    await fetcher(joinUrl(notificationsUrl, `/${notificationId}`), {
      method: "DELETE",
    });
    if (expandedId === notificationId) setExpandedId(null);
    mutateNotifications();
    mutateUnreadCount();
  };

  const handleNotificationClick = (notif: NotificationListItem) => {
    if (!notif.isRead) {
      handleMarkAsRead(notif.id);
    }
    setExpandedId(expandedId === notif.id ? null : notif.id);
  };

  const hasContent = notifications.length > 0 || invitations.length > 0;

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        setExpandedId(null);
        if (open) {
          mutateNotifications();
          mutateUnreadCount();
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative">
          <Bell className="h-5 w-5" />
          {totalCount > 0 && (
            <span className="absolute -top-0 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-[10px] font-medium text-destructive-foreground">
              {totalCount}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>Notifications</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {!hasContent ? (
          <div className="p-4 text-center text-sm text-muted-foreground">
            No new notifications
          </div>
        ) : (
          <>
            <div className="max-h-96 overflow-y-auto">
              {notifications.map((notif) => {
                const isExpanded = expandedId === notif.id;
                return (
                  <div
                    key={notif.id}
                    className="group/notif flex items-start gap-3 p-3 cursor-pointer hover:bg-accent rounded-sm relative"
                    onClick={() => handleNotificationClick(notif)}
                  >
                    <Avatar className="size-7 shrink-0 mt-0.5">
                      {notif.agentAvatarUrl ? (
                        <AvatarImage
                          src={notif.agentAvatarUrl}
                          alt={notif.agentName}
                        />
                      ) : null}
                      <AvatarFallback>
                        <Bot className="size-3.5" />
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground truncate">
                          {notif.agentName}
                        </span>
                        {!notif.isRead && (
                          <span className="size-2 rounded-full bg-primary shrink-0" />
                        )}
                      </div>
                      {notif.title && (
                        <div className="text-sm font-medium truncate">
                          {notif.title}
                        </div>
                      )}
                      <div
                        className={`text-xs text-muted-foreground prose prose-sm dark:prose-invert max-w-none [&_p]:m-0 [&_a]:text-primary ${isExpanded ? "" : "line-clamp-2"}`}
                      >
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          allowedElements={[
                            "p",
                            "a",
                            "strong",
                            "em",
                            "code",
                          ]}
                          components={{
                            a: ({ children, href }) => (
                              <a
                                href={href}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {children}
                              </a>
                            ),
                          }}
                        >
                          {notif.body}
                        </ReactMarkdown>
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-xs text-muted-foreground">
                          {formatRelativeTime(notif.createdAt)}
                        </span>
                        <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground">
                          {isExpanded ? (
                            <>
                              Show less
                              <ChevronUp className="size-3" />
                            </>
                          ) : (
                            <>
                              Show more
                              <ChevronDown className="size-3" />
                            </>
                          )}
                        </span>
                      </div>
                    </div>
                    <button
                      className="absolute top-2 right-2 p-0.5 rounded-sm opacity-0 group-hover/notif:opacity-100 hover:bg-muted-foreground/20 text-muted-foreground hover:text-foreground transition-opacity"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDismiss(notif.id);
                      }}
                      aria-label="Dismiss notification"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                );
              })}
              {notifications.length > 0 && invitations.length > 0 && (
                <DropdownMenuSeparator />
              )}
              {invitations.map((invite) => (
                <DropdownMenuItem key={invite.id} asChild>
                  <Link
                    href="/settings/invitations"
                    className="flex flex-col items-start gap-1 p-3 cursor-pointer"
                  >
                    <div className="flex items-center gap-2 font-medium">
                      <Mail className="h-4 w-4" />
                      Organization Invitation
                    </div>
                    <div className="text-xs text-muted-foreground line-clamp-2">
                      You've been invited to join{" "}
                      <strong>{invite.organizationName}</strong>.
                    </div>
                  </Link>
                </DropdownMenuItem>
              ))}
            </div>
            {unreadNotificationCount > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="w-full justify-center text-center font-medium cursor-pointer"
                  onClick={handleMarkAllAsRead}
                >
                  Mark all as read
                </DropdownMenuItem>
              </>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
