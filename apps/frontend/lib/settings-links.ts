import {
  Blocks,
  BookText,
  Bot,
  Box,
  Info,
  Layers,
  Mail,
  Network,
  Radio,
  Settings,
  ShieldCheck,
  Sparkles,
  Unplug,
  User,
  Users,
  Webhook,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { orgRoutes, userRoutes, workspaceRoutes } from "@/lib/routes";

// why: no "use client" — the server-rendered header reads these too

export type SettingsNavLink = {
  href: string;
  icon: LucideIcon;
  label: string;
  exact?: boolean;
};

export function orgSettingsLinks(orgId: string): SettingsNavLink[] {
  const routes = orgRoutes(orgId).settings;
  return [
    { href: routes.root, icon: Settings, label: "General", exact: true },
    { href: routes.members, icon: Users, label: "Members" },
    { href: routes.invitations, icon: Mail, label: "Invitations" },
    { href: routes.providers, icon: Unplug, label: "Providers" },
    { href: routes.mcp, icon: Wrench, label: "MCP Servers" },
    { href: routes.skills, icon: Sparkles, label: "Skills" },
    { href: routes.agents, icon: Bot, label: "Agents" },
    { href: routes.blueprints, icon: Layers, label: "Blueprints" },
    { href: routes.plugins, icon: Blocks, label: "Plugins" },
    {
      href: routes.inboundTriggers,
      icon: Webhook,
      label: "Inbound Triggers",
    },
    { href: routes.a2a, icon: Network, label: "A2A endpoints" },
  ];
}

export function workspaceSettingsLinks(
  orgId: string,
  workspaceId: string,
): SettingsNavLink[] {
  const routes = workspaceRoutes(orgId, workspaceId).settings;
  return [
    { href: routes.root, icon: Settings, label: "Workspace", exact: true },
    { href: routes.providers, icon: Unplug, label: "Providers" },
    { href: routes.mcp, icon: Wrench, label: "MCP Servers" },
    { href: routes.sandbox, icon: Box, label: "Sandbox" },
    { href: routes.webhooks, icon: Radio, label: "Webhooks" },
    { href: routes.a2aEndpoints, icon: Network, label: "A2A endpoints" },
    { href: routes.about, icon: Info, label: "About" },
  ];
}

export function userSettingsLinks(isSuperAdmin: boolean): SettingsNavLink[] {
  return [
    { href: userRoutes.profile, icon: User, label: "Profile", exact: true },
    { href: userRoutes.contexts, icon: BookText, label: "Contexts" },
    {
      href: userRoutes.security,
      icon: ShieldCheck,
      label: "Security",
      exact: true,
    },
    {
      href: userRoutes.invitations,
      icon: Mail,
      label: "Invitations",
      exact: true,
    },
    ...(isSuperAdmin
      ? [{ href: userRoutes.users, icon: Users, label: "Users", exact: true }]
      : []),
  ];
}
