import type { Metadata } from "next";
import { SandboxSettings } from "@/components/sandbox-settings";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Sandbox" };

async function SandboxPage({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) {
  const { orgId, workspaceId } = await params;

  return (
    <div>
      <PageHeader title="Sandbox" />
      <SandboxSettings orgId={orgId} workspaceId={workspaceId} />
    </div>
  );
}

export default SandboxPage;
