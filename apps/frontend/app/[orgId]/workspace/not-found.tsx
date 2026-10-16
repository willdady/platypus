import { WorkspaceNotFound } from "@/components/workspace-not-found";
import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { SidebarInset } from "@/components/ui/sidebar";

/**
 * A missing Workspace: the Workspace layout's read came back 404. Renders
 * beside the sidebar, so the way to another Workspace stays in reach.
 */
export default function NotFound() {
  return (
    <SidebarInset id={MAIN_CONTENT_ID} className="min-w-0">
      <WorkspaceNotFound />
    </SidebarInset>
  );
}
