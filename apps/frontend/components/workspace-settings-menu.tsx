"use client";

import { SettingsNavMenu } from "@/components/settings-nav-menu";
import { workspaceSettingsLinks } from "@/lib/settings-links";

type WorkspaceSettingsMenuProps = {
  orgId: string;
  workspaceId: string;
};

export function WorkspaceSettingsMenu({
  orgId,
  workspaceId,
}: WorkspaceSettingsMenuProps) {
  return <SettingsNavMenu links={workspaceSettingsLinks(orgId, workspaceId)} />;
}
