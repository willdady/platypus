"use client";

import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import useSWR, { useSWRConfig } from "swr";
import { fetcher, joinUrl } from "@/lib/utils";
import { toast } from "sonner";
import type { Workspace, ChatListItem, Organization } from "@platypus/schemas";
import { useAuth } from "@/components/auth-provider";
import {
  Sidebar,
  SidebarContent,
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
import { Badge } from "@/components/ui/badge";
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
import { useState, useEffect } from "react";
import {
  FolderOpen,
  BotMessageSquare,
  EllipsisVertical,
  Trash2,
  Pencil,
  Pin,
  PinOff,
  FolderClosed,
  ChevronsUpDown,
  Plus,
  ClockFading,
  CalendarDays,
  ArrowLeftRight,
  Search,
  Loader2,
  X,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel, FieldError } from "@/components/ui/field";
import { parseValidationErrors } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";
import { TagInput } from "@/components/tag-input";
import { useIsMobile } from "@/hooks/use-mobile";

export function AppSidebar() {
  const { orgId, workspaceId } = useParams<{
    orgId: string;
    workspaceId: string;
  }>();
  const { user } = useAuth();
  const backendUrl = useBackendUrl();
  const isMobile = useIsMobile();

  const pathname = usePathname();
  const router = useRouter();

  const [renameChatId, setRenameChatId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [renameTags, setRenameTags] = useState<string[]>([]);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValidationErrors, setRenameValidationErrors] = useState<
    Record<string, string>
  >({});
  const [deleteChatId, setDeleteChatId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isTogglingPin, setIsTogglingPin] = useState(false);

  const { mutate } = useSWRConfig();

  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchInput);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Helper to revalidate the chat list (handles query params in SWR key)
  const revalidateChatList = () => {
    const chatListUrl = joinUrl(
      backendUrl,
      `/organizations/${orgId}/workspaces/${workspaceId}/chat`,
    );
    return mutate(
      (key: unknown) => typeof key === "string" && key.startsWith(chatListUrl),
    );
  };

  const { data } = useSWR<{ results: Workspace[] }>(
    backendUrl && user
      ? joinUrl(backendUrl, `/organizations/${orgId}/workspaces`)
      : null,
    fetcher,
  );

  const searchParam = debouncedSearch
    ? `&search=${encodeURIComponent(debouncedSearch)}`
    : "";
  const { data: chatData } = useSWR<{ results: ChatListItem[] }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/chat?limit=100${searchParam}`,
        )
      : null,
    fetcher,
  );

  const { data: orgData } = useSWR<Organization>(
    backendUrl && user ? joinUrl(backendUrl, `/organizations/${orgId}`) : null,
    fetcher,
  );

  const workspaces = (data?.results ?? []).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const chats = chatData?.results ?? [];
  const currentWorkspace = workspaces.find((w) => w.id === workspaceId);

  // Separate pinned chats from regular chats
  const pinnedChats = chats.filter((chat) => chat.isPinned);
  const regularChats = chats.filter((chat) => !chat.isPinned);

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
    ...(pinnedChats.length > 0
      ? [{ label: "Pinned", chats: pinnedChats, icon: Pin }]
      : []),
    ...(hasRecent
      ? [{ label: "Last 7 days", chats: last7Days, icon: ClockFading }]
      : []),
    {
      label: hasRecent ? "Other" : "Chats",
      chats: hasRecent ? other : regularChats,
      icon: CalendarDays,
    },
  ].filter((group) => group.chats.length > 0);

  const handleRenameChat = async () => {
    if (!renameChatId) return;

    const currentChat = chats.find((chat) => chat.id === renameChatId);
    if (!currentChat) return;

    setIsRenaming(true);
    setRenameValidationErrors({});
    try {
      const response = await fetch(
        joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/chat/${renameChatId}`,
        ),
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            workspaceId,
            title: renameTitle,
            isPinned: currentChat.isPinned,
            tags: renameTags,
          }),
          credentials: "include",
        },
      );

      if (response.ok) {
        // Close the dialog
        setRenameChatId(null);
        setRenameTitle("");
        setRenameTags([]);

        // Revalidate the chat list
        await revalidateChatList();
      } else {
        // Parse standardschema.dev validation errors
        const errorData = await response.json();
        setRenameValidationErrors(parseValidationErrors(errorData));
        console.error("Failed to rename chat");
      }
    } catch (error) {
      console.error("Error renaming chat:", error);
      toast.error("Failed to rename chat");
    } finally {
      setIsRenaming(false);
    }
  };

  const handleDeleteChat = async () => {
    if (!deleteChatId) return;

    setIsDeleting(true);
    try {
      const response = await fetch(
        joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/chat/${deleteChatId}`,
        ),
        {
          method: "DELETE",
          credentials: "include",
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
      await revalidateChatList();
    } catch (error) {
      console.error("Error deleting chat:", error);
      toast.error("Failed to delete chat");
    } finally {
      setIsDeleting(false);
    }
  };

  const handleTogglePin = async (chatId: string) => {
    const currentChat = chats.find((chat) => chat.id === chatId);
    if (!currentChat) return;

    setIsTogglingPin(true);
    try {
      const response = await fetch(
        joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/chat/${chatId}`,
        ),
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            workspaceId,
            title: currentChat.title,
            isPinned: !currentChat.isPinned,
            tags: currentChat.tags ?? [],
          }),
          credentials: "include",
        },
      );

      if (!response.ok) {
        throw new Error("Failed to toggle pin status");
      }

      // Revalidate the chat list
      await revalidateChatList();
    } catch (error) {
      console.error("Error toggling pin status:", error);
      toast.error("Failed to update pin status");
    } finally {
      setIsTogglingPin(false);
    }
  };

  return (
    <>
      <Sidebar>
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuButton className="h-auto py-2">
                    <div className="flex flex-col flex-1 items-start leading-none">
                      <span className="text-xs text-muted-foreground mb-1">
                        {orgData?.name}
                      </span>
                      <div className="flex items-center gap-2 w-full">
                        <FolderOpen className="size-4 shrink-0" />
                        <span className="font-medium">
                          {currentWorkspace?.name}
                        </span>
                        <ChevronsUpDown className="ml-auto size-4 shrink-0" />
                      </div>
                    </div>
                  </SidebarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  className="w-56"
                  align="start"
                  side={isMobile ? "bottom" : "right"}
                >
                  <DropdownMenuLabel className="text-xs text-muted-foreground">
                    Workspaces
                  </DropdownMenuLabel>
                  <DropdownMenuGroup>
                    {workspaces.map((workspace) => {
                      const href = `/${workspace.organizationId}/workspace/${workspace.id}`;
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
                      <Link
                        className="cursor-pointer"
                        href={`/${orgId}/create`}
                      >
                        <Plus /> Add Workspace
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link className="cursor-pointer" href={`/${orgId}`}>
                        <ArrowLeftRight /> Switch Org
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
          </SidebarMenu>
        </SidebarHeader>
        <SidebarSeparator className="mx-0 mt-1" />
        <div className="px-2 py-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
            <Input
              type="search"
              placeholder="Search chats..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="h-8 pl-8 pr-8"
            />
            {searchInput && (
              <button
                type="button"
                onClick={() => setSearchInput("")}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground cursor-pointer"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
        </div>
        <div className="relative min-h-0 flex flex-col flex-1 overflow-hidden">
          <SidebarContent className="pb-16">
            {chatGroups.length === 0 && debouncedSearch && (
              <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                No chats match &ldquo;{debouncedSearch}&rdquo;
              </div>
            )}
            {chatGroups.map((group) => (
              <SidebarGroup key={group.label}>
                <SidebarGroupLabel>
                  <group.icon className="mr-2 h-4 w-4" />
                  {group.label}
                </SidebarGroupLabel>
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
                              {chat.status === "running" && (
                                <Loader2
                                  className="h-3 w-3 shrink-0 animate-spin text-muted-foreground"
                                  aria-label="Run in progress"
                                />
                              )}
                              <p className="truncate">{chat.title}</p>
                            </Link>
                          </SidebarMenuButton>
                          <DropdownMenu modal={false}>
                            <DropdownMenuTrigger asChild>
                              <SidebarMenuAction className="cursor-pointer text-muted-foreground">
                                <EllipsisVertical className="h-4 w-4" />
                              </SidebarMenuAction>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                              className="max-w-3xs"
                              side="right"
                              align="start"
                            >
                              <DropdownMenuItem
                                className="cursor-pointer"
                                onSelect={() => handleTogglePin(chat.id)}
                                disabled={isTogglingPin}
                              >
                                {chat.isPinned ? (
                                  <>
                                    <PinOff className="h-4 w-4" /> Unpin
                                  </>
                                ) : (
                                  <>
                                    <Pin className="h-4 w-4" /> Pin
                                  </>
                                )}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="cursor-pointer"
                                onSelect={() => {
                                  setRenameChatId(chat.id);
                                  setRenameTitle(chat.title);
                                  setRenameTags(chat.tags ?? []);
                                  setRenameValidationErrors({});
                                }}
                              >
                                <Pencil className="h-4 w-4" /> Edit
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="cursor-pointer"
                                onSelect={() => setDeleteChatId(chat.id)}
                              >
                                <Trash2 className="h-4 w-4" /> Delete
                              </DropdownMenuItem>
                              {chat.tags && chat.tags.length > 0 && (
                                <>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuGroup className="flex flex-wrap p-1 gap-1">
                                    {chat.tags.map((tag: string) => (
                                      <Badge
                                        key={tag}
                                        className="cursor-default"
                                        variant="secondary"
                                      >
                                        {tag}
                                      </Badge>
                                    ))}
                                  </DropdownMenuGroup>
                                </>
                              )}
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
          <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-sidebar to-transparent" />
        </div>
      </Sidebar>

      {/* Rename Chat Dialog */}
      <Dialog
        open={!!renameChatId}
        onOpenChange={(open) => {
          if (!open) {
            setRenameChatId(null);
            setRenameTitle("");
            setRenameTags([]);
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
            <DialogTitle>Edit Chat</DialogTitle>
            <DialogDescription>
              Update the chat title and tags.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-4">
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

            <Field data-invalid={!!renameValidationErrors.tags}>
              <FieldLabel>Tags</FieldLabel>
              <TagInput
                value={renameTags}
                onChange={setRenameTags}
                disabled={isRenaming}
              />
              {renameValidationErrors.tags && (
                <FieldError>{renameValidationErrors.tags}</FieldError>
              )}
            </Field>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setRenameChatId(null);
                setRenameTitle("");
                setRenameTags([]);
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
              Save Changes
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
