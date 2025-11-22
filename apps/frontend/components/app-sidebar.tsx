"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import useSWR, { mutate } from "swr";
import { fetcher } from "@/lib/utils";
import type { Workspace, ChatListItem } from "@agent-kit/schemas";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
  Folder,
  FolderOpen,
  BotMessageSquare,
  EllipsisVertical,
  Trash2,
  Pencil,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel, FieldError } from "@/components/ui/field";
import { parseValidationErrors } from "@/lib/utils";

export function AppSidebar({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) {
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

  const { data } = useSWR<{ results: Workspace[] }>(
    `${process.env.NEXT_PUBLIC_BACKEND_URL}/workspaces?orgId=${orgId}`,
    fetcher,
  );

  const { data: chatData } = useSWR<{ results: ChatListItem[] }>(
    `${process.env.NEXT_PUBLIC_BACKEND_URL}/chat?workspaceId=${workspaceId}`,
    fetcher,
  );

  const workspaces = data?.results ?? [];
  const chats = chatData?.results ?? [];
  const currentWorkspace = workspaces.find((w) => w.id === workspaceId);

  const handleWorkspaceChange = (newWorkspaceId: string) => {
    router.push(`/${orgId}/workspace/${newWorkspaceId}/chat`);
  };

  const handleRenameChat = async () => {
    if (!renameChatId) return;

    setIsRenaming(true);
    setRenameValidationErrors({});
    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/chat/${renameChatId}?workspaceId=${workspaceId}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            workspaceId,
            title: renameTitle,
          }),
        },
      );

      if (response.ok) {
        // Close the dialog
        setRenameChatId(null);
        setRenameTitle("");

        // Revalidate the chat list
        await mutate(
          `${process.env.NEXT_PUBLIC_BACKEND_URL}/chat?workspaceId=${workspaceId}`,
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
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/chat/${deleteChatId}?workspaceId=${workspaceId}`,
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
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/chat?workspaceId=${workspaceId}`,
      );
    } catch (error) {
      console.error("Error deleting chat:", error);
    } finally {
      setIsDeleting(false);
    }
  };

  const primaryItems = [
    {
      title: "Agents",
      url: `/${orgId}/workspace/${workspaceId}/agents`,
      icon: Bot,
    },
  ];

  const secondaryItems = [
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
          <Select value={workspaceId} onValueChange={handleWorkspaceChange}>
            <SelectTrigger className="w-full cursor-pointer">
              <SelectValue>
                <FolderOpen /> {currentWorkspace?.name}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Workspaces</SelectLabel>
                {workspaces.map((workspace) => (
                  <SelectItem
                    key={workspace.id}
                    className="cursor-pointer"
                    value={workspace.id}
                  >
                    {currentWorkspace?.id === workspace.id ? (
                      <FolderOpen />
                    ) : (
                      <Folder />
                    )}{" "}
                    {workspace.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button asChild className="w-full mt-2">
            <Link href={`/${orgId}/workspace/${workspaceId}/chat`}>
              <BotMessageSquare /> New Chat
            </Link>
          </Button>
        </SidebarHeader>
        <SidebarContent className="justify-between">
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {primaryItems.map((item) => (
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
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup className="flex-1">
            <SidebarGroupContent>
              <SidebarMenu>
                {chats.map((chat) => (
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
                          {chat.title}
                        </Link>
                      </SidebarMenuButton>
                      <DropdownMenu modal={false}>
                        <DropdownMenuTrigger asChild>
                          <SidebarMenuAction className="cursor-pointer">
                            <EllipsisVertical className="h-4 w-4" />
                          </SidebarMenuAction>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent side="right" align="start">
                          <DropdownMenuItem
                            onSelect={() => {
                              setRenameChatId(chat.id);
                              setRenameTitle(chat.title);
                              setRenameValidationErrors({});
                            }}
                          >
                            <Pencil className="mr-2 h-4 w-4" /> Rename
                          </DropdownMenuItem>
                          <DropdownMenuItem
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
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {secondaryItems.map((item) => (
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
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter />
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
              {isRenaming ? "Renaming..." : "Rename"}
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
              {isDeleting ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
