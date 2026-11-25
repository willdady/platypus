"use client";

import { WorkspaceShell } from "@/components/workspace-shell";
import { LoadingRegion } from "@/components/list-skeletons";
import { useWorkspaceShellProps } from "@/hooks/use-workspace-shell-props";

// why: a segment's own loading can't cover its layout, so only the shell is drawn
export default function WorkspaceLoading() {
  const shell = useWorkspaceShellProps();

  return (
    <WorkspaceShell {...shell}>
      <LoadingRegion label="Loading workspace" className="flex-1">
        {null}
      </LoadingRegion>
    </WorkspaceShell>
  );
}
