"use client";

import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useSWRConfig } from "swr";
import {
  chatListEntity,
  organizationEntity,
  scopedUrl,
  writeEntity,
  type Serialized,
} from "@/lib/api-write";
import { toast } from "sonner";
import type { Workspace, ChatListItem, Organization } from "@platypus/schemas";
import { useAuth, useBackendUrl } from "@/components/auth-provider";
import {
  canChangeChat,
  canConfigureWorkspaceResource,
  canCreateWorkspace,
  canOpenOrgSettings,
} from "@/lib/authorization";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { useScopedList } from "@/hooks/use-scoped-list";
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
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
import { useState, useEffect, useRef } from "react";
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
  Settings,
  Loader2,
  Network,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { SearchInput } from "@/components/search-input";
import { Field, FieldLabel, FieldError } from "@/components/ui/field";
import { TagInput } from "@/components/tag-input";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  activeChatIdFromPathname,
  chatListPoll,
  type WatchedChat,
} from "@/lib/chat-list-poll";
import { orgRoutes, workspaceRoutes } from "@/lib/routes";

export function AppSidebar() {
  const { orgId, workspaceId } = useParams<{
    orgId: string;
    workspaceId: string;
  }>();
  const backendUrl = useBackendUrl();
  const { actor, ownsWorkspace, workspaceDelegation } = useAuth();
  // Chats belong to the Workspace Owner; everyone else reads them, so the
  // row menu offers nobody else an action the backend would refuse.
  const canChange = canChangeChat(ownsWorkspace);
  const isMobile = useIsMobile();

  const routes = workspaceRoutes(orgId, workspaceId);
  const org = orgRoutes(orgId);
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

  // Helper to revalidate the chat list (handles query params in SWR key)
  const revalidateChatList = () => {
    const chatListUrl = scopedUrl(backendUrl, chatListEntity(), scope);
    return mutate(
      (key: unknown) => typeof key === "string" && key.startsWith(chatListUrl),
    );
  };

  const { results: allWorkspaces, isLoading: isWorkspacesLoading } =
    useScopedList<Workspace>("workspaces", { orgId });

  const { data: chatData, isLoading: isChatListLoading } = useScopedSWR<{
    results: ChatListItem[];
  }>(chatListEntity({ limit: 100, search: debouncedSearch }), scope, {
    // Nothing else revalidates this list: not the per-chat spinner rendered
    // off it, not the chat row the backend creates when a run starts, not
    // the title written after that run ends. See `lib/chat-list-poll` for
    // what each poll waits on and how it stops.
    //
    // SWR calls this when it arms the next timer — on every render and after
    // every fetch — which is also when the set of chats being waited on is
    // worth recomputing: a route change is a render, and a chat arriving is
    // a fetch.
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
  const canAddProvider = canConfigureWorkspaceResource(
    actor,
    "provider",
    workspaceDelegation?.providerSelfManagement === true,
  );

  const { data: orgData, isLoading: isOrgLoading } = useScopedSWR<Organization>(
    organizationEntity(orgId),
    {},
  );

  // Each search is its own SWR key, so the list would blank (and falsely read
  // as "no matches") on every debounced keystroke. Keep showing the last
  // settled list until the new one lands — but only within this Workspace:
  // the sidebar outlives a Workspace switch, and SWR's `keepPreviousData`
  // would show the old Workspace's chats under the new one's routes.
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

  const workspaces = [...allWorkspaces].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const chats = pins.apply(shownChatList?.data.results ?? []);
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

  const {
    formData: renameData,
    setFormData: setRenameData,
    validationErrors: renameValidationErrors,
    setValidationErrors: setRenameValidationErrors,
    isSubmitting: isRenaming,
    setField: setRenameField,
    submit: submitRename,
  } = useEntityForm<{ title: string; tags: string[] }>({
    initialData: { title: "", tags: [] },
    guardUnsavedChanges: false,
    entity: "chat",
    scope,
    id: renameChatId ?? undefined,
    buildPayload: (data) => ({
      workspaceId,
      ...data,
      isPinned: chats.find((chat) => chat.id === renameChatId)?.isPinned,
    }),
    // A chat has no field a conflict could key to.
    conflictField: null,
    onSuccess: async () => {
      setRenameChatId(null);
      // The list is read under query params the write's own keys don't cover.
      await revalidateChatList();
    },
  });

  const chatDelete = useDeleteFlow<string>({
    delete: (chatId) => writeEntity(backendUrl, "chat", scope, { id: chatId }),
    mutate: revalidateChatList,
    onSuccess: (chatId) => {
      // Leave the deleted chat if it is the one open.
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
      <Sidebar>
        <nav aria-label="Workspace" className="flex min-h-0 flex-1 flex-col">
          <SidebarHeader>
            <SidebarMenu>
              <SidebarMenuItem>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <SidebarMenuButton className="h-auto py-2">
                      <div className="flex flex-col flex-1 items-start leading-none">
                        {/* Placeholders keep the button's height and width
                          steady until the names land. `text-xs` carries a
                          16px line box, so the bar is padded out to it. */}
                        {!orgData && isOrgLoading ? (
                          <Skeleton
                            data-testid="org-name-skeleton"
                            className="mt-0.5 mb-1.5 h-3 w-24"
                          />
                        ) : (
                          <span className="text-xs text-muted-foreground mb-1">
                            {orgData?.name}
                          </span>
                        )}
                        <div className="flex items-center gap-2 w-full">
                          <FolderOpen className="size-4 shrink-0" />
                          {!currentWorkspace && isWorkspacesLoading ? (
                            <Skeleton
                              data-testid="workspace-name-skeleton"
                              className="h-3.5 w-28"
                            />
                          ) : (
                            <span className="font-medium">
                              {currentWorkspace?.name}
                            </span>
                          )}
                          <ChevronsUpDown className="ml-auto size-4 shrink-0" />
                        </div>
                      </div>
                    </SidebarMenuButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    className="w-56 bg-sidebar-panel"
                    align="start"
                    side={isMobile ? "bottom" : "right"}
                  >
                    <DropdownMenuLabel className="text-xs text-muted-foreground">
                      Workspaces
                    </DropdownMenuLabel>
                    <DropdownMenuGroup>
                      {workspaces.map((workspace) => {
                        const href = workspaceRoutes(
                          workspace.organizationId,
                          workspace.id,
                        ).root;
                        return (
                          <DropdownMenuItem key={workspace.id} asChild>
                            <Link href={href}>
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
                      {/* ADR-0008: Workspace creation is org-admin-only. */}
                      {canCreateWorkspace(actor) && (
                        <DropdownMenuItem asChild>
                          <Link href={org.createWorkspace}>
                            <Plus /> Add workspace
                          </Link>
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem asChild>
                        <Link href={org.root}>
                          <ArrowLeftRight /> Switch org
                        </Link>
                      </DropdownMenuItem>
                      {canOpenOrgSettings(actor) && (
                        <DropdownMenuItem asChild>
                          <Link href={org.settings.root}>
                            <Settings /> Organization settings
                          </Link>
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </SidebarMenuItem>
              <SidebarMenuItem>
                {hasNoProviders ? (
                  <Tooltip>
                    {/* A disabled button fires no pointer or focus events, so
                      the wrapper is what opens the tooltip. */}
                    <TooltipTrigger asChild>
                      <span tabIndex={0} className="block">
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
                    <Link href={routes.chat.root}>
                      <BotMessageSquare /> New chat
                    </Link>
                  </Button>
                )}
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarHeader>
          <SidebarSeparator className="mx-0 mt-1" />
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
              {/* Names the search the shown list answered, not the one in
                flight, so a pending search never reads as "no matches". */}
              {chatGroups.length === 0 && shownChatList?.search && (
                <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No chats match &ldquo;{shownChatList.search}&rdquo;
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
                              <Link href={routes.chat.detail(chat.id)}>
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
                            {(canChange ||
                              (chat.tags && chat.tags.length > 0)) && (
                              <DropdownMenu modal={false}>
                                <DropdownMenuTrigger asChild>
                                  <SidebarMenuAction
                                    className="text-muted-foreground"
                                    aria-label="Chat options"
                                  >
                                    <EllipsisVertical className="size-4" />
                                  </SidebarMenuAction>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent
                                  className="max-w-3xs"
                                  side="right"
                                  align="start"
                                >
                                  {canChange && (
                                    <>
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
                                      <DropdownMenuItem
                                        onSelect={() => {
                                          setRenameChatId(chat.id);
                                          setRenameData({
                                            title: chat.title,
                                            tags: chat.tags ?? [],
                                          });
                                          setRenameValidationErrors({});
                                        }}
                                      >
                                        <Pencil className="size-4" /> Edit
                                      </DropdownMenuItem>
                                      <DropdownMenuItem
                                        onSelect={() =>
                                          chatDelete.request(chat.id)
                                        }
                                      >
                                        <Trash2 className="size-4" /> Delete
                                      </DropdownMenuItem>
                                    </>
                                  )}
                                  {chat.tags && chat.tags.length > 0 && (
                                    <>
                                      {canChange && <DropdownMenuSeparator />}
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

      {/* Rename Chat Dialog */}
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
            <DialogTitle>Edit Chat</DialogTitle>
            <DialogDescription>
              Update the chat title and tags.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 flex flex-col gap-4">
            <Field data-invalid={!!renameValidationErrors.title}>
              <FieldLabel htmlFor="title">Title</FieldLabel>
              <Input
                id="title"
                value={renameData.title}
                onChange={(e) => setRenameField("title", e.target.value)}
                placeholder="Chat title"
                disabled={isRenaming}
                aria-invalid={!!renameValidationErrors.title}
              />
              {renameValidationErrors.title && (
                <FieldError>{renameValidationErrors.title}</FieldError>
              )}
            </Field>

            <Field data-invalid={!!renameValidationErrors.tags}>
              <FieldLabel htmlFor="tags">Tags</FieldLabel>
              <TagInput
                id="tags"
                value={renameData.tags}
                onChange={(tags) => setRenameField("tags", tags)}
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

      <DeleteConfirmDialog
        open={chatDelete.open}
        onOpenChange={(open) => !open && chatDelete.close()}
        title="Delete Chat"
        description="Are you sure you want to delete this chat? This action cannot be undone."
        onConfirm={chatDelete.confirm}
        loading={chatDelete.deleting}
        error={chatDelete.error}
      />
    </>
  );
}

/** Stands in for the first chat-history group until the list first loads. */
function ChatHistorySkeleton() {
  return (
    <SidebarGroup role="status" aria-label="Loading chats">
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
  );
}
