"use client";

import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useSWRConfig } from "swr";
import {
  chatListEntity,
  matchesCollection,
  writeEntity,
  type Serialized,
} from "@/lib/api-write";
import type { ChatListItem } from "@platypus/schemas";
import { useAuth, useBackendUrl } from "@/components/auth-provider";
import { canChangeChat } from "@/lib/authorization";
import { useCanConfigureWorkspaceResource } from "@/hooks/use-can-configure-workspace-resource";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { useEntityForm } from "@/hooks/use-entity-form";
import { useDeleteFlow } from "@/hooks/use-delete-flow";
import { useHasNoProviders } from "@/hooks/use-has-no-providers";
import { useOptimisticRows } from "@/hooks/use-optimistic-rows";
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
  SidebarMenuSkeleton,
  SidebarSeparator,
  useSidebar,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadingRegion } from "@/components/list-skeletons";
import { ListState } from "@/components/list-state";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
import { useState, useEffect, useRef } from "react";
import {
  BotMessageSquare,
  EllipsisVertical,
  Trash2,
  Pencil,
  Pin,
  PinOff,
  ClockFading,
  CalendarDays,
  Loader2,
  Network,
} from "lucide-react";
import { SearchInput } from "@/components/search-input";
import { FormTextField } from "@/components/form-text-field";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  activeChatIdFromPathname,
  chatListPoll,
  type WatchedChat,
} from "@/lib/chat-list-poll";
import { workspaceRoutes } from "@/lib/routes";
import { WorkspaceSheetNavigation } from "@/components/workspace-sheet-navigation";

export function AppSidebar() {
  const { orgId, workspaceId } = useParams<{
    orgId: string;
    workspaceId: string;
  }>();
  const backendUrl = useBackendUrl();
  const { ownsWorkspace } = useAuth();
  const canChange = canChangeChat(ownsWorkspace);
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const closeSheet = () => setOpenMobile(false);

  const routes = workspaceRoutes(orgId, workspaceId);
  const scope = { orgId, workspaceId };

  const pathname = usePathname();
  const router = useRouter();

  const [renameChatId, setRenameChatId] = useState<string | null>(null);
  const pins = useOptimisticRows<Serialized<ChatListItem>>();

  const { mutate } = useSWRConfig();

  const activeChatId = activeChatIdFromPathname(pathname, orgId, workspaceId);
  const watchedChatsRef = useRef<WatchedChat[]>([]);

  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchInput);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const revalidateChatList = () =>
    mutate((key: unknown) =>
      matchesCollection(key, backendUrl, chatListEntity(), scope),
    );

  const { data: chatData, isLoading: isChatListLoading } = useScopedSWR<{
    results: ChatListItem[];
  }>(chatListEntity({ limit: 100, search: debouncedSearch }), scope, {
    // why: SWR arms this on every render and fetch, which is when the watched set changes
    refreshInterval: (latest) => {
      const { watched, intervalMs } = chatListPoll({
        watched: watchedChatsRef.current,
        listed: latest?.results,
        activeChatId,
        now: Date.now(),
        isSearching: debouncedSearch !== "",
      });
      watchedChatsRef.current = watched;
      return intervalMs;
    },
  });

  const hasNoProviders = useHasNoProviders(scope);
  const canAddProvider = useCanConfigureWorkspaceResource("provider");

  const chatListScopeKey = `${orgId}/${workspaceId}`;
  const [settledChatList, setSettledChatList] = useState<{
    scopeKey: string;
    search: string;
    data: { results: Serialized<ChatListItem>[] };
  } | null>(null);
  if (chatData && settledChatList?.data !== chatData) {
    setSettledChatList({
      scopeKey: chatListScopeKey,
      search: debouncedSearch,
      data: chatData,
    });
  }
  const shownChatList =
    settledChatList?.scopeKey === chatListScopeKey ? settledChatList : null;

  const chats = pins.apply(shownChatList?.data.results ?? []);

  const pinnedChats = chats.filter((chat) => chat.isPinned);
  const regularChats = chats.filter((chat) => !chat.isPinned);

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

  const {
    formData: renameData,
    setFormData: setRenameData,
    validationErrors: renameValidationErrors,
    setValidationErrors: setRenameValidationErrors,
    isSubmitting: isRenaming,
    setField: setRenameField,
    submit: submitRename,
  } = useEntityForm<{ title: string }>({
    initialData: { title: "" },
    guardUnsavedChanges: false,
    entity: "chat",
    scope,
    id: renameChatId ?? undefined,
    method: "PATCH",
    buildPayload: (data) => ({
      ...data,
      isPinned: chats.find((chat) => chat.id === renameChatId)?.isPinned,
    }),
    conflictField: null,
    invalidMessage: null,
    onSuccess: async () => {
      setRenameChatId(null);
      // why: the list is read under query params the write's own keys do not cover
      await revalidateChatList();
    },
  });

  const chatDelete = useDeleteFlow<string>({
    delete: (chatId) => writeEntity(backendUrl, "chat", scope, { id: chatId }),
    mutate: revalidateChatList,
    onSuccess: (chatId) => {
      if (pathname.startsWith(routes.chat.detail(chatId))) {
        router.push(routes.chat.root);
      }
    },
  });

  const handleTogglePin = (chat: Serialized<ChatListItem>) => {
    const data = { isPinned: !chat.isPinned };
    void pins.run(
      chat.id,
      data,
      () => writeEntity(backendUrl, "chat", scope, { id: chat.id, data }),
      revalidateChatList,
    );
  };

  return (
    <>
      <Sidebar className="group-data-[state=expanded]:left-(--workspace-rail-width)">
        {isMobile && (
          <WorkspaceSheetNavigation
            orgId={orgId}
            workspaceId={workspaceId}
            onNavigate={closeSheet}
          />
        )}
        <nav aria-label="Chats" className="flex min-h-0 flex-1 flex-col">
          <SidebarHeader>
            <SidebarMenu>
              <SidebarMenuItem>
                {hasNoProviders ? (
                  // why: a disabled button fires no pointer or focus events, so the span opens it
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        tabIndex={0}
                        data-testid="new-chat-hint"
                        className="block"
                      >
                        <Button disabled className="w-full">
                          <BotMessageSquare /> New chat
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      {canAddProvider
                        ? "Add a provider to start a chat"
                        : "Ask an organization admin to add a provider"}
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <Button asChild className="w-full">
                    <Link href={routes.chat.root} onClick={closeSheet}>
                      <BotMessageSquare /> New chat
                    </Link>
                  </Button>
                )}
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarHeader>
          <SidebarSeparator className="mx-0" />
          <div className="p-2">
            <SearchInput
              placeholder="Search chats..."
              aria-label="Search chats"
              value={searchInput}
              onValueChange={setSearchInput}
              inputClassName="h-8"
            />
          </div>
          <div className="relative min-h-0 flex flex-col flex-1 overflow-hidden">
            <SidebarContent className="pb-16">
              {!shownChatList && isChatListLoading && <ChatHistorySkeleton />}
              {chatGroups.length === 0 && shownChatList?.search && (
                <div className="p-2">
                  <ListState variant="empty">
                    No chats match &ldquo;{shownChatList.search}&rdquo;
                  </ListState>
                </div>
              )}
              {chatGroups.map((group) => (
                <SidebarGroup key={group.label}>
                  <SidebarGroupLabel>
                    <group.icon className="mr-2 size-4" />
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
                                routes.chat.detail(chat.id),
                              )}
                            >
                              <Link
                                href={routes.chat.detail(chat.id)}
                                onClick={closeSheet}
                              >
                                {chat.status === "running" && (
                                  <Loader2
                                    className="size-3 shrink-0 animate-spin text-muted-foreground"
                                    aria-label="Run in progress"
                                  />
                                )}
                                {chat.a2aClientName && (
                                  <Network
                                    className="size-3 shrink-0 text-muted-foreground"
                                    role="img"
                                    aria-label={`Over A2A from ${chat.a2aClientName}`}
                                  >
                                    <title>{`Over A2A from ${chat.a2aClientName}`}</title>
                                  </Network>
                                )}
                                <p className="truncate">{chat.title}</p>
                              </Link>
                            </SidebarMenuButton>
                            {canChange && (
                              <DropdownMenu modal={false}>
                                <DropdownMenuTrigger asChild>
                                  <SidebarMenuAction
                                    className="text-muted-foreground"
                                    aria-label={`Actions for ${chat.title}`}
                                  >
                                    <EllipsisVertical className="size-4" />
                                  </SidebarMenuAction>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent
                                  className="max-w-3xs"
                                  side="right"
                                  align="start"
                                >
                                  <DropdownMenuItem
                                    onSelect={() => {
                                      setRenameChatId(chat.id);
                                      setRenameData({
                                        title: chat.title,
                                      });
                                      setRenameValidationErrors({});
                                    }}
                                  >
                                    <Pencil className="size-4" /> Edit
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onSelect={() => handleTogglePin(chat)}
                                    disabled={pins.isPending(chat.id)}
                                  >
                                    {chat.isPinned ? (
                                      <>
                                        <PinOff className="size-4" /> Unpin
                                      </>
                                    ) : (
                                      <>
                                        <Pin className="size-4" /> Pin
                                      </>
                                    )}
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    variant="destructive"
                                    onSelect={() => chatDelete.request(chat.id)}
                                  >
                                    <Trash2 className="size-4" /> Delete
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            )}
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
        </nav>
      </Sidebar>

      <Dialog
        open={!!renameChatId}
        onOpenChange={(open) => !open && setRenameChatId(null)}
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
            <DialogTitle>Edit chat</DialogTitle>
            <DialogDescription>Update the chat title.</DialogDescription>
          </DialogHeader>
          <div className="py-4 flex flex-col gap-4">
            <FormTextField
              label="Title"
              name="title"
              value={renameData.title}
              onChange={(value) => setRenameField("title", value)}
              placeholder="Chat title"
              disabled={isRenaming}
              error={renameValidationErrors.title}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRenameChatId(null)}
              disabled={isRenaming}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void submitRename()}
              disabled={isRenaming || !renameData.title.trim()}
            >
              {isRenaming ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DeleteConfirmDialog noun="chat" {...chatDelete.dialogProps} />
    </>
  );
}

function ChatHistorySkeleton() {
  return (
    <LoadingRegion label="Loading chats">
      <SidebarGroup>
        <SidebarGroupLabel>
          <Skeleton className="mr-2 size-4" />
          <Skeleton className="h-3 w-20" />
        </SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {Array.from({ length: 5 }, (_, i) => (
              <SidebarMenuItem key={i}>
                <SidebarMenuSkeleton />
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </LoadingRegion>
  );
}
