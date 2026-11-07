"use client";

import { RouteError, type ErrorBoundaryProps } from "@/components/route-error";
import { WorkspaceShell } from "@/components/workspace-shell";
import { useWorkspaceShellProps } from "@/hooks/use-workspace-shell-props";

/**
 * A Workspace page that threw. The Workspace layout draws no chrome, so this
 * brings the shell the route lives in — the sidebar on the Workspace home and
 * Chat, the plain shell elsewhere. If the sidebar itself threw, this fallback
 * throws too and the parent Workspace boundary keeps the plain shell.
 */
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
