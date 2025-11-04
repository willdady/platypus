import Link from 'next/link'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Home, Settings, Zap, Bot, Unplug } from "lucide-react";

export function AppSidebar({orgId, workspaceId}: {orgId: string, workspaceId: string}) {

  const primaryItems = [
    {
      title: "Home",
      url: `/${orgId}/workspace/${workspaceId}`,
      icon: Home,
    },
    {
      title: "Quick Chat",
      url: `/${orgId}/workspace/${workspaceId}/chat`,
      icon: Zap,
    },
    {
      title: "Agents",
      url: `/${orgId}/workspace/${workspaceId}/agents`,
      icon: Bot,
    },
    {
      title: "MCP",
      url: `/${orgId}/workspace/${workspaceId}/mcp`,
      icon: Unplug,
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
      <SidebarHeader />
      <SidebarContent className='justify-between'>
        <SidebarGroup>
          <SidebarGroupLabel>Application</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {primaryItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild>
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
                  <SidebarMenuButton asChild>
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
