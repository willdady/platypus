"use client";

import { SettingsNavMenu } from "@/components/settings-nav-menu";
import { useAuth } from "@/components/auth-provider";
import { isOperator } from "@/lib/authorization";
import { userSettingsLinks } from "@/lib/settings-links";

export function UserSettingsMenu() {
  const { actor } = useAuth();

  return <SettingsNavMenu links={userSettingsLinks(isOperator(actor))} />;
}
