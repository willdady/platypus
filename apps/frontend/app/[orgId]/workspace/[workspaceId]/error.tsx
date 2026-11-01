"use client";

import { useParams } from "next/navigation";
import { RouteError, type ErrorBoundaryProps } from "@/components/route-error";
import { WorkspaceShell } from "@/components/workspace-shell";

/**
 * A Workspace page that threw. The Workspace layout draws no chrome, so this
 * brings the plain shell, whose header leads to the Organization home.
 */
export default function WorkspacePageError({
  error,
  retry,
}: ErrorBoundaryProps) {
  const { orgId } = useParams<{ orgId: string }>();
  return (
    <WorkspaceShell orgId={orgId}>
      <RouteError error={error} retry={retry} source="segment" />
    </WorkspaceShell>
  );
}
