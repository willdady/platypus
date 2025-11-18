"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import useSWR from "swr";
import { fetcher } from "@/lib/utils";
import type { Workspace } from "@agent-kit/schemas";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
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
  Settings,
  Bot,
  Folder,
  FolderOpen,
  BotMessageSquare,
} from "lucide-react";

export function AppSidebar({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) {
  const pathname = usePathname();
  const router = useRouter();

  const { data } = useSWR<{ results: Workspace[] }>(
    `${process.env.NEXT_PUBLIC_BACKEND_URL}/workspaces?orgId=${orgId}`,
    fetcher,
  );

  const workspaces = data?.results ?? [];
  const currentWorkspace = workspaces.find((w) => w.id === workspaceId);

  const handleWorkspaceChange = (newWorkspaceId: string) => {
    router.push(`/${orgId}/workspace/${newWorkspaceId}/chat`);
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
  );
}
