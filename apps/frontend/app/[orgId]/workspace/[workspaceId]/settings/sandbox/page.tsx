import type { Metadata } from "next";
import { SandboxSettings } from "@/components/sandbox-settings";

export const metadata: Metadata = { title: "Sandbox" };

async function SandboxPage({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) {
  const { orgId, workspaceId } = await params;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Sandbox</h1>
      <SandboxSettings orgId={orgId} workspaceId={workspaceId} />
    </div>
  );
}

export default SandboxPage;
