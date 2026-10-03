import {
  BookText,
  Box,
  Info,
  Mail,
  Radio,
  Settings,
  ShieldCheck,
  Unplug,
  User,
  Users,
  Wrench,
} from "lucide-react";
import { userRoutes, workspaceRoutes } from "@/lib/routes";

// Plain module, not "use client": the server-rendered header reads these too.

/**
 * The Workspace settings pages, shared by its sidebar and the header's
 * settings dropdown. `exact` marks a link only active on its own path.
 */
export function workspaceSettingsLinks(orgId: string, workspaceId: string) {
  const routes = workspaceRoutes(orgId, workspaceId).settings;
  return [
    { href: routes.root, icon: Settings, label: "Workspace", exact: true },
    { href: routes.providers, icon: Unplug, label: "Providers" },
    { href: routes.mcp, icon: Wrench, label: "MCP" },
    { href: routes.sandbox, icon: Box, label: "Sandbox" },
    { href: routes.webhooks, icon: Radio, label: "Webhooks" },
    { href: routes.about, icon: Info, label: "About" },
  ];
}

/**
 * The User's own settings pages, shared by their sidebar and the account menu.
 * Users is for super admins only. `exact` marks a link only active on its own
 * path.
 */
export function userSettingsLinks(isSuperAdmin: boolean) {
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
