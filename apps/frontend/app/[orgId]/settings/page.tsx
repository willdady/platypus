import type { Metadata } from "next";
import OrgSettingsPage from "./organization-settings";

export const metadata: Metadata = { title: "Organization Settings" };

export default async function Page({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  return <OrgSettingsPage orgId={orgId} />;
}
