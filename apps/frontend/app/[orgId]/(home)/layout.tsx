import { HeaderHomeButton } from "@/components/header-home-button";
import { OrgListSidebar } from "@/components/org-list-sidebar";
import { SettingsShell } from "@/components/settings-shell";

export default async function OrgHomeLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  return (
    <SettingsShell
      menu={<OrgListSidebar currentOrgId={orgId} />}
      headerLeft={<HeaderHomeButton />}
      columnWidth="narrow"
      menuWidth="wide"
      contentClassName="px-3"
    >
      {children}
    </SettingsShell>
  );
}
