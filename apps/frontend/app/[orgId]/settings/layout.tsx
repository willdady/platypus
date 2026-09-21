import { cache } from "react";
import { headers } from "next/headers";
import type { Metadata } from "next";
import type { Organization } from "@platypus/schemas";
import { joinUrl } from "@/lib/utils";
import { OrgSettingsMenu } from "@/components/org-settings-menu";
import { SettingsShell } from "@/components/settings-shell";
import { BackButton } from "@/components/back-button";
import { HeaderHomeButton } from "@/components/header-home-button";
import { ProtectedRoute } from "@/components/protected-route";

// Cached so the metadata and the layout body share one request: both need the
// organization, and `cache` collapses them into a single backend call.
const fetchOrganization = cache(async function fetchOrganization(
  orgId: string,
): Promise<Organization | null> {
  const backendUrl =
    process.env.INTERNAL_BACKEND_URL || process.env.BACKEND_URL || "";
  const headersList = await headers();
  // Unlike the workspace shell, a failure here must not break the page: the
  // organization is only a label and the title, so it degrades to null.
  try {
    const response = await fetch(
      joinUrl(backendUrl, `/organizations/${orgId}`),
      {
        headers: {
          cookie: headersList.get("cookie") || "",
        },
      },
    );
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ orgId: string }>;
}): Promise<Metadata> {
  const { orgId } = await params;
  const organization = await fetchOrganization(orgId);

  return {
    title: organization ? `${organization.name} | Platypus` : "Platypus",
  };
}

export default async function OrgSettingsLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ orgId: string }>;
}>) {
  const { orgId } = await params;
  const organization = await fetchOrganization(orgId);

  return (
    <ProtectedRoute requireOrgAccess requireOrgAdmin>
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
