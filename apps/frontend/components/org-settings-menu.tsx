"use client";

import { SidebarSeparator } from "@/components/ui/sidebar";
import { SettingsNavMenu } from "@/components/settings-nav-menu";
import { orgSettingsLinks } from "@/lib/settings-links";

type OrgSettingsMenuProps = {
  orgId: string;
  /**
   * Resolved by the settings layout. Undefined when the organization could not
   * be fetched, in which case the heading is left out rather than blocking the
   * settings pages behind an error.
   */
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
          {/* Sets the static heading apart from the links below it */}
          <SidebarSeparator className="mx-0 my-1" />
        </>
      )}
    </SettingsNavMenu>
  );
}
