"use client";

import { RouteError, type ErrorBoundaryProps } from "@/components/route-error";
import { WorkspaceShell } from "@/components/workspace-shell";
import { useWorkspaceShellProps } from "@/hooks/use-workspace-shell-props";

export default function WorkspacePageError({
  error,
  retry,
}: ErrorBoundaryProps) {
  const shell = useWorkspaceShellProps();

  return (
    <WorkspaceShell {...shell}>
      <RouteError error={error} retry={retry} source="segment" />
    </WorkspaceShell>
  );
}
