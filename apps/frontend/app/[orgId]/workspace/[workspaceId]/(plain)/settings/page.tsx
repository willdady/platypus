import type { Metadata } from "next";
import WorkspaceSettingsPage from "./workspace-settings";

export const metadata: Metadata = { title: "Workspace Settings" };

export default async function Page({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) {
  const { orgId, workspaceId } = await params;
  return <WorkspaceSettingsPage orgId={orgId} workspaceId={workspaceId} />;
}
