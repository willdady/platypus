import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { scopedTitle } from "@/lib/page-title";
import { backendPath, serverRead } from "@/lib/server-read";
import { ProtectedRoute } from "@/components/protected-route";
import type { Workspace } from "@platypus/schemas";

function readWorkspace(orgId: string, workspaceId: string) {
  return serverRead<Workspace>(
    backendPath`/organizations/${orgId}/workspaces/${workspaceId}`,
  );
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}): Promise<Metadata> {
  const { orgId, workspaceId } = await params;
  const workspace = await readWorkspace(orgId, workspaceId);

  return { title: scopedTitle(workspace.ok ? workspace.body.name : undefined) };
}

export default async function WorkspaceLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ orgId: string; workspaceId: string }>;
}>) {
  const { orgId, workspaceId } = await params;
  const workspace = await readWorkspace(orgId, workspaceId);

  if (!workspace.ok && workspace.status === 404) {
    notFound();
  }
  // Any other failure — a timeout included — goes to the error boundary,
  // which offers to try again, rather than rendering the Workspace over a read
  // that failed. A 401 or 403 is left to `ProtectedRoute`, which signs the
  // caller in or says why they are turned away.
  if (!workspace.ok && workspace.status !== 401 && workspace.status !== 403) {
    throw new Error(`Workspace read failed: ${workspace.status}`);
  }

  return <ProtectedRoute requireWorkspaceAccess>{children}</ProtectedRoute>;
}
