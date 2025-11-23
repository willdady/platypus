"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import useSWR, { useSWRConfig } from "swr";
import { fetcher } from "@/lib/utils";
import type { Workspace, ChatListItem } from "@agent-kit/schemas";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useState } from "react";
import {
  Settings,
  Bot,
  FolderOpen,
  BotMessageSquare,
  EllipsisVertical,
  Trash2,
  Pencil,
  Star,
  StarOff,
  FolderClosed,
  ChevronsUpDown,
  Plus,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel, FieldError } from "@/components/ui/field";
import { parseValidationErrors } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";

export function AppSidebar({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) {
  const backendUrl = useBackendUrl();

  const pathname = usePathname();
  const router = useRouter();

  const [renameChatId, setRenameChatId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValidationErrors, setRenameValidationErrors] = useState<
    Record<string, string>
  >({});
  const [deleteChatId, setDeleteChatId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isTogglingStar, setIsTogglingStar] = useState(false);

  const { mutate } = useSWRConfig();
  const { data } = useSWR<{ results: Workspace[] }>(
    `${backendUrl}/workspaces?orgId=${orgId}`,
    fetcher,
  );

  const { data: chatData } = useSWR<{ results: ChatListItem[] }>(
    `${backendUrl}/chat?workspaceId=${workspaceId}`,
    fetcher,
  );

  const workspaces = data?.results ?? [];
  const chats = chatData?.results ?? [];
  const currentWorkspace = workspaces.find((w) => w.id === workspaceId);

  // Separate starred chats from regular chats
  const starredChats = chats.filter((chat) => chat.isStarred);
  const regularChats = chats.filter((chat) => !chat.isStarred);

  // Group regular chats by time periods
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const last7Days = regularChats.filter(
    (chat) => new Date(chat.createdAt) >= sevenDaysAgo,
  );
  const other = regularChats.filter(
    (chat) => new Date(chat.createdAt) < sevenDaysAgo,
  );

  const hasRecent = last7Days.length > 0;

  const chatGroups = [
    ...(starredChats.length > 0
      ? [{ label: "Starred", chats: starredChats }]
      : []),
    ...(hasRecent ? [{ label: "Last 7 days", chats: last7Days }] : []),
    {
      label: hasRecent ? "Other" : "Chats",
      chats: hasRecent ? other : regularChats,
    },
  ].filter((group) => group.chats.length > 0);

  const handleWorkspaceChange = (newWorkspaceId: string) => {
    router.push(`/${orgId}/workspace/${newWorkspaceId}/chat`);
  };

  const handleRenameChat = async () => {
    if (!renameChatId) return;

    const currentChat = chats.find((chat) => chat.id === renameChatId);
    if (!currentChat) return;

    setIsRenaming(true);
    setRenameValidationErrors({});
    try {
      const response = await fetch(
        `${backendUrl}/chat/${renameChatId}?workspaceId=${workspaceId}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            workspaceId,
            title: renameTitle,
            isStarred: currentChat.isStarred,
          }),
        },
      );

      if (response.ok) {
        // Close the dialog
        setRenameChatId(null);
        setRenameTitle("");

        // Revalidate the chat list
        await mutate(
          `${backendUrl}/chat?workspaceId=${workspaceId}`,
        );
      } else {
        // Parse standardschema.dev validation errors
        const errorData = await response.json();
        setRenameValidationErrors(parseValidationErrors(errorData));
        console.error("Failed to rename chat");
      }
    } catch (error) {
      console.error("Error renaming chat:", error);
    } finally {
      setIsRenaming(false);
    }
  };

  const handleDeleteChat = async () => {
    if (!deleteChatId) return;

    setIsDeleting(true);
    try {
      const response = await fetch(
        `${backendUrl}/chat/${deleteChatId}?workspaceId=${workspaceId}`,
        {
          method: "DELETE",
        },
      );

      if (!response.ok) {
        throw new Error("Failed to delete chat");
      }

      // Close the dialog
      setDeleteChatId(null);

      // Navigate to the main chat page if we were on the deleted chat
      if (
        pathname.startsWith(
          `/${orgId}/workspace/${workspaceId}/chat/${deleteChatId}`,
        )
      ) {
        router.push(`/${orgId}/workspace/${workspaceId}/chat`);
      }

      // Revalidate the chat list
      await mutate(
        `${backendUrl}/chat?workspaceId=${workspaceId}`,
      );
    } catch (error) {
      console.error("Error deleting chat:", error);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleToggleStar = async (chatId: string) => {
    const currentChat = chats.find((chat) => chat.id === chatId);
    if (!currentChat) return;

    setIsTogglingStar(true);
    try {
      const response = await fetch(
        `${backendUrl}/chat/${chatId}?workspaceId=${workspaceId}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            workspaceId,
            title: currentChat.title,
            isStarred: !currentChat.isStarred,
          }),
        },
      );

      if (!response.ok) {
        throw new Error("Failed to toggle star status");
      }

      // Revalidate the chat list
      await mutate(
        `${backendUrl}/chat?workspaceId=${workspaceId}`,
      );
    } catch (error) {
      console.error("Error toggling star status:", error);
    } finally {
      setIsTogglingStar(false);
    }
  };

  const footerItems = [
    {
      title: "Agents",
      url: `/${orgId}/workspace/${workspaceId}/agents`,
      icon: Bot,
    },
    {
      title: "Settings",
      url: `/${orgId}/workspace/${workspaceId}/settings`,
      icon: Settings,
    },
  ];

  return (
    <>
      <Sidebar>
        <SidebarHeader>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton className="cursor-pointer">
                  <div className="inline-flex flex-1 [&>svg]:size-4 [&>svg]:shrink-0 items-center gap-2">
                    <FolderOpen /> <span>{currentWorkspace?.name}</span>
                  </div>
                  <ChevronsUpDown />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-56" align="start" side="right">
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  Workspaces
                </DropdownMenuLabel>
                <DropdownMenuGroup>
                  {workspaces.map((workspace) => {
                    const href = `/${workspace.organisationId}/workspace/${workspace.id}`;
                    return (
                      <DropdownMenuItem key={workspace.id} asChild>
                        <Link className="cursor-pointer" href={href}>
                          {pathname.startsWith(href) ? (
                            <FolderOpen />
                          ) : (
                            <FolderClosed />
                          )}{" "}
                          {workspace.name}
                        </Link>
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem asChild>
                    <Link className="cursor-pointer" href={`/${orgId}/create`}>
                      <Plus /> Create Workspace
                    </Link>
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <Button asChild className="w-full">
              <Link href={`/${orgId}/workspace/${workspaceId}/chat`}>
                <BotMessageSquare /> New Chat
              </Link>
            </Button>
          </SidebarMenuItem>
        </SidebarHeader>
        <SidebarSeparator className="mx-0 mt-1" />
        <SidebarContent>
          {chatGroups.map((group) => (
            <SidebarGroup key={group.label}>
              <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.chats.map((chat) => (
                    <SidebarMenuItem key={chat.id}>
                      <div className="flex items-center justify-between w-full">
                        <SidebarMenuButton
                          asChild
                          isActive={pathname.startsWith(
                            `/${orgId}/workspace/${workspaceId}/chat/${chat.id}`,
                          )}
                        >
                          <Link
                            href={`/${orgId}/workspace/${workspaceId}/chat/${chat.id}`}
                          >
                            <p className="truncate">{chat.title}</p>
                          </Link>
                        </SidebarMenuButton>
                        <DropdownMenu modal={false}>
                          <DropdownMenuTrigger asChild>
                            <SidebarMenuAction className="cursor-pointer text-muted-foreground">
                              <EllipsisVertical className="h-4 w-4" />
                            </SidebarMenuAction>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent side="right" align="start">
                            <DropdownMenuItem
                              className="cursor-pointer"
                              onSelect={() => handleToggleStar(chat.id)}
                              disabled={isTogglingStar}
                            >
                              {chat.isStarred ? (
                                <>
                                  <StarOff className="mr-2 h-4 w-4" /> Unstar
                                </>
                              ) : (
                                <>
                                  <Star className="mr-2 h-4 w-4" /> Star
                                </>
                              )}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="cursor-pointer"
                              onSelect={() => {
                                setRenameChatId(chat.id);
                                setRenameTitle(chat.title);
                                setRenameValidationErrors({});
                              }}
                            >
                              <Pencil className="mr-2 h-4 w-4" /> Rename
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="cursor-pointer"
                              onSelect={() => setDeleteChatId(chat.id)}
                            >
                              <Trash2 className="mr-2 h-4 w-4" /> Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            {footerItems.map((item) => (
              <SidebarMenuItem key={item.title}>
                <SidebarMenuButton
                  asChild
                  isActive={pathname.startsWith(item.url)}
                >
                  <Link href={item.url}>
                    <item.icon />
                    <span>{item.title}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>

      {/* Rename Chat Dialog */}
      <Dialog
        open={!!renameChatId}
        onOpenChange={(open) => {
          if (!open) {
            setRenameChatId(null);
            setRenameTitle("");
          }
        }}
      >
        <DialogContent
          onPointerDownOutside={(e) => {
            if (isRenaming) {
              e.preventDefault();
            }
          }}
          onEscapeKeyDown={(e) => {
            if (isRenaming) {
              e.preventDefault();
            }
          }}
          showCloseButton={false}
        >
          <DialogHeader>
            <DialogTitle>Rename Chat</DialogTitle>
            <DialogDescription>
              Enter a new name for this chat.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Field data-invalid={!!renameValidationErrors.title}>
              <FieldLabel htmlFor="title">Title</FieldLabel>
              <Input
                id="title"
                value={renameTitle}
                onChange={(e) => setRenameTitle(e.target.value)}
                placeholder="Chat title"
                disabled={isRenaming}
                aria-invalid={!!renameValidationErrors.title}
              />
              {renameValidationErrors.title && (
                <FieldError>{renameValidationErrors.title}</FieldError>
              )}
            </Field>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setRenameChatId(null);
                setRenameTitle("");
              }}
              disabled={isRenaming}
              className="cursor-pointer"
            >
              Cancel
            </Button>
            <Button
              onClick={handleRenameChat}
              disabled={isRenaming || !renameTitle.trim()}
              className="cursor-pointer"
            >
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Chat Confirmation Dialog */}
      <Dialog
        open={!!deleteChatId}
        onOpenChange={(open) => !open && setDeleteChatId(null)}
      >
        <DialogContent
          onPointerDownOutside={(e) => {
            if (isDeleting) {
              e.preventDefault();
            }
          }}
          onEscapeKeyDown={(e) => {
            if (isDeleting) {
              e.preventDefault();
            }
          }}
          showCloseButton={false}
        >
          <DialogHeader>
            <DialogTitle>Delete Chat</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this chat? This action cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteChatId(null)}
              disabled={isDeleting}
              className="cursor-pointer"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteChat}
              disabled={isDeleting}
              className="cursor-pointer"
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
