"use client";

import { SidebarSeparator } from "@/components/ui/sidebar";
import { SettingsNavMenu } from "@/components/settings-nav-menu";
import { orgSettingsLinks } from "@/lib/settings-links";

type OrgSettingsMenuProps = {
  orgId: string;
  organizationName?: string;
};

export function OrgSettingsMenu({
  orgId,
  organizationName,
}: OrgSettingsMenuProps) {
  return (
    <SettingsNavMenu links={orgSettingsLinks(orgId)}>
      {organizationName && (
        <>
          <h2
            title={organizationName}
            className="h-8 truncate px-2 text-sm leading-8 font-medium"
          >
            {organizationName}
          </h2>
          <SidebarSeparator className="mx-0 my-1" decorative={false} />
        </>
      )}
    </SettingsNavMenu>
  );
}
