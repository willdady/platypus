import type { Metadata } from "next";
import { scopedTitle } from "@/lib/page-title";
import type { Organization } from "@platypus/schemas";
import { backendPath, readForLabel } from "@/lib/server-read";
import { OrgSettingsMenu } from "@/components/org-settings-menu";
import { SettingsShell } from "@/components/settings-shell";
import { BackButton } from "@/components/back-button";
import { HeaderHomeButton } from "@/components/header-home-button";
import { ProtectedRoute } from "@/components/protected-route";

// Unlike the workspace shell, a failure here must not break the page: the
// organization is only a label and the title, so it degrades to null.
const readOrganization = (orgId: string) =>
  readForLabel<Organization>(backendPath`/organizations/${orgId}`);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ orgId: string }>;
}): Promise<Metadata> {
  const { orgId } = await params;
  const organization = await readOrganization(orgId);

  return { title: scopedTitle(organization?.name) };
}

export default async function OrgSettingsLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ orgId: string }>;
}>) {
  const { orgId } = await params;
  const organization = await readOrganization(orgId);

  return (
    <ProtectedRoute requireOrgAdmin>
      <SettingsShell
        menu={
          <OrgSettingsMenu
            orgId={orgId}
            organizationName={organization?.name}
          />
        }
        headerLeft={
          <div className="flex items-center gap-2">
            <BackButton variant="header" />
            <HeaderHomeButton />
          </div>
        }
        contentClassName="p-2"
      >
        {children}
      </SettingsShell>
    </ProtectedRoute>
  );
}
