"use client";

import { useParams } from "next/navigation";
import { WorkspaceNotFound } from "@/components/workspace-not-found";
import { WorkspaceShell } from "@/components/workspace-shell";

export default function NotFound() {
  const { orgId } = useParams<{ orgId: string }>();
  return (
    <WorkspaceShell orgId={orgId}>
      <WorkspaceNotFound />
    </WorkspaceShell>
  );
}
