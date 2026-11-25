"use client";

import { Fragment, useState } from "react";
import { useBackendUrl } from "@/components/auth-provider";
import { Bell, Mail, ChevronDown, ChevronUp, X } from "lucide-react";
import { AgentAvatar } from "@/components/agent-avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { writeEntity, type Serialized } from "@/lib/api-write";
import { formatRelativeTime } from "@/lib/relative-time";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { useScopedList } from "@/hooks/use-scoped-list";
import { useOptimisticRows } from "@/hooks/use-optimistic-rows";
import { useRevalidateOnRestore } from "@/hooks/use-revalidate-on-restore";
import {
  type InvitationListItem,
  type NotificationListItem,
  type NotificationSource,
} from "@platypus/schemas";
import Link from "next/link";
import dynamic from "next/dynamic";
import { toast } from "sonner";
import { userRoutes, workspaceRoutes } from "@/lib/routes";
import { cn } from "@/lib/utils";

// why: Markdown is heavy and rides every page, so it loads when the bell opens
const Markdown = dynamic(
  () => import("@/components/markdown").then((m) => m.Markdown),
  { ssr: false },
);

type NotificationsDropdownProps = {
  orgId?: string;
  workspaceId?: string;
};

export function NotificationsDropdown({
  orgId,
  workspaceId,
}: NotificationsDropdownProps) {
  const backendUrl = useBackendUrl();
  const [isOpen, setIsOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const scope = orgId && workspaceId ? { orgId, workspaceId } : null;

  const { results: notificationRows, mutate: mutateNotifications } =
    useScopedList<NotificationListItem>(
      "notifications",
      isOpen ? scope : null,
      { refreshInterval: 30000 },
    );

  const { data: unreadCountData, mutate: mutateUnreadCount } = useScopedSWR<{
    count: number;
  }>("notifications/unread-count", scope, {
    refreshInterval: isOpen ? 30000 : 0,
  });

  useRevalidateOnRestore(() => void mutateUnreadCount());

  const { results: invitations } = useScopedList<InvitationListItem>(
    "users/me/invitations",
    {},
    { refreshInterval: isOpen ? 60000 * 2 : 0 },
  );

  const optimistic = useOptimisticRows<Serialized<NotificationListItem>>();
  const notifications = optimistic.apply(notificationRows);
  const unreadNotificationCount = Math.max(
    0,
    (unreadCountData?.count ?? 0) -
      notificationRows.filter((n) => !n.isRead && optimistic.isPending(n.id))
        .length,
  );
  const totalCount = unreadNotificationCount + invitations.length;

  // why: list first — a count landing while an override stands counts the row twice
  const revalidate = async () => {
    await mutateNotifications();
    await mutateUnreadCount();
  };

  const handleMarkAsRead = (notificationId: string) => {
    if (!backendUrl || !orgId || !workspaceId) return;
    void optimistic.run(
      notificationId,
      { isRead: true },
      () =>
        writeEntity(backendUrl, `notifications/${notificationId}/read`, {
          orgId,
          workspaceId,
        }),
      revalidate,
    );
  };

  const handleMarkAllAsRead = async () => {
    if (!backendUrl || !orgId || !workspaceId) return;
    const outcome = await writeEntity(backendUrl, "notifications/read-all", {
      orgId,
      workspaceId,
    });
    if (outcome.outcome !== "success") {
      toast.error(outcome.message);
      return;
    }
    void mutateNotifications();
    void mutateUnreadCount();
  };

  const handleDismiss = (notificationId: string) => {
    if (!backendUrl || !orgId || !workspaceId) return;
    if (expandedId === notificationId) setExpandedId(null);
    void optimistic.run(
      notificationId,
      null,
      () =>
        writeEntity(
          backendUrl,
          "notifications",
          { orgId, workspaceId },
          { id: notificationId },
        ),
      revalidate,
    );
  };

  const handleNotificationClick = (notif: Serialized<NotificationListItem>) => {
    if (!notif.isRead) {
      handleMarkAsRead(notif.id);
    }
    setExpandedId(expandedId === notif.id ? null : notif.id);
  };

  const sourceHref = (source: NotificationSource) => {
    if (!source || !orgId || !workspaceId) return null;
    const routes = workspaceRoutes(orgId, workspaceId);
    return source.kind === "chat"
      ? routes.chat.detail(source.chatId)
      : routes.triggerRuns.detail(source.triggerRunId);
  };

  const hasContent = notifications.length > 0 || invitations.length > 0;

  return (
    <DropdownMenu
      open={isOpen}
      onOpenChange={(open) => {
        setIsOpen(open);
        setExpandedId(null);
        if (open) void mutateUnreadCount();
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          className="relative"
          aria-label={
            totalCount > 0 ? `Notifications (${totalCount})` : "Notifications"
          }
        >
          <Bell />
          {totalCount > 0 && (
            <span className="absolute -top-0 -right-0.5 flex size-4 items-center justify-center rounded-full bg-destructive text-2xs font-medium text-destructive-foreground dark:bg-destructive/60">
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
                const href = sourceHref(notif.source);
                return (
                  <Fragment key={notif.id}>
                    <DropdownMenuItem
                      className="group/notif flex items-start gap-3 p-3 rounded-sm relative"
                      textValue={notif.title ?? notif.agentName ?? "Platypus"}
                      aria-expanded={isExpanded}
                      aria-keyshortcuts="Delete"
                      onSelect={(event) => {
                        event.preventDefault();
                        handleNotificationClick(notif);
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Delete") return;
                        event.preventDefault();
                        handleDismiss(notif.id);
                      }}
                    >
                      <AgentAvatar
                        agent={{
                          name: notif.agentName ?? "Platypus",
                          avatarUrl: notif.agentAvatarUrl,
                        }}
                        className="size-7 shrink-0 mt-0.5"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground truncate">
                            {notif.agentName ?? "Platypus"}
                          </span>
                          {!notif.isRead && (
                            <>
                              <span
                                aria-hidden="true"
                                className="size-2 rounded-full bg-primary shrink-0"
                              />
                              <span className="sr-only">Unread</span>
                            </>
                          )}
                        </div>
                        {notif.title && (
                          <div className="text-sm font-medium truncate">
                            {notif.title}
                          </div>
                        )}
                        {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
                        <div
                          onClick={(e) => {
                            const target = e.target as Element;
                            if (
                              !e.currentTarget.contains(target) ||
                              target.closest("button")
                            ) {
                              e.stopPropagation();
                            }
                          }}
                          className={cn(
                            "text-xs text-muted-foreground [&_p]:m-0 [&_a]:text-primary [&_ul]:m-0 [&_ol]:m-0 [&_li]:py-0",
                            !isExpanded && "line-clamp-2",
                          )}
                        >
                          <Markdown
                            allowedElements={[
                              "p",
                              "a",
                              "strong",
                              "em",
                              "code",
                              "ul",
                              "ol",
                              "li",
                            ]}
                            unwrapDisallowed
                          >
                            {notif.body}
                          </Markdown>
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
                        type="button"
                        className="absolute top-2 right-2 p-0.5 rounded-sm hover:bg-muted-foreground/20 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDismiss(notif.id);
                        }}
                        aria-label="Dismiss notification"
                      >
                        <X className="size-3.5" />
                      </button>
                    </DropdownMenuItem>
                    {href && (
                      <DropdownMenuItem
                        asChild
                        className="ml-10 mb-1 w-fit px-2 py-0.5 text-xs text-primary"
                      >
                        <Link
                          href={href}
                          onClick={() => {
                            if (!notif.isRead) handleMarkAsRead(notif.id);
                          }}
                        >
                          Open
                        </Link>
                      </DropdownMenuItem>
                    )}
                  </Fragment>
                );
              })}
              {notifications.length > 0 && invitations.length > 0 && (
                <DropdownMenuSeparator />
              )}
              {invitations.map((invite) => (
                <DropdownMenuItem key={invite.id} asChild>
                  <Link
                    href={userRoutes.invitations}
                    className="flex flex-col items-start gap-1 p-3"
                  >
                    <div className="flex items-center gap-2 font-medium">
                      <Mail className="size-4" />
                      Organization Invitation
                    </div>
                    <div className="text-xs text-muted-foreground line-clamp-2">
                      You&apos;ve been invited to join{" "}
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
                  className="w-full justify-center text-center font-medium"
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
