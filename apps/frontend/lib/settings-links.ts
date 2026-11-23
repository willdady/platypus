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

// Plain module, not "use client": the server-rendered header reads these too.

export type SettingsNavLink = {
  href: string;
  icon: LucideIcon;
  label: string;
  /** Marks a link only active on its own path, not on paths beneath it. */
  exact?: boolean;
};

/** The Organization settings pages, listed in its settings sidebar. */
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

/** The Workspace settings pages, listed in its settings sidebar. */
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

/**
 * The User's own settings pages, shared by their sidebar and the account menu.
 * Users is for super admins only.
 */
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
