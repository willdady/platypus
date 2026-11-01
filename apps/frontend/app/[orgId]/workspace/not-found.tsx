"use client";

import { useParams } from "next/navigation";
import { WorkspaceNotFound } from "@/components/workspace-not-found";
import { WorkspaceShell } from "@/components/workspace-shell";

/**
 * A missing Workspace: the Workspace layout's read came back 404. Renders in
 * the plain shell, whose header leads to the Organization home.
 */
export default function NotFound() {
  const { orgId } = useParams<{ orgId: string }>();
  return (
    <WorkspaceShell orgId={orgId}>
      <WorkspaceNotFound />
    </WorkspaceShell>
  );
}
