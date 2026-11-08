"use client";

import { WorkspaceShell } from "@/components/workspace-shell";
import { LoadingRegion } from "@/components/list-skeletons";
import { useWorkspaceShellProps } from "@/hooks/use-workspace-shell-props";

// The Workspace layout awaits the workspace on the server, and a segment's
// own `loading` can't cover its layout — so the fallback lives here, one
// segment up. It draws the shell the route is about to land in (sidebar for
// home and Chat, plain otherwise) so only the content area changes when the
// Workspace lands, and leaves that area empty: it stands in for every
// Workspace page, so any placeholder drawn there would be the wrong shape,
// then swapped for the page's own skeleton. It shows when entering or
// switching Workspaces; navigation within one keeps the page up.
export default function WorkspaceLoading() {
  const shell = useWorkspaceShellProps();

  return (
    <WorkspaceShell {...shell}>
      {/* The content area waits blank until the page lands. */}
      <LoadingRegion label="Loading workspace" className="flex-1">
        {null}
      </LoadingRegion>
    </WorkspaceShell>
  );
}
