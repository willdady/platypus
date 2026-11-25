"use client";

import { useParams } from "next/navigation";
import { RouteError, type ErrorBoundaryProps } from "@/components/route-error";
import { WorkspaceShell } from "@/components/workspace-shell";

export default function WorkspaceError({ error, retry }: ErrorBoundaryProps) {
  const { orgId } = useParams<{ orgId: string }>();
  return (
    <WorkspaceShell orgId={orgId}>
      <RouteError error={error} retry={retry} source="segment" />
    </WorkspaceShell>
  );
}
