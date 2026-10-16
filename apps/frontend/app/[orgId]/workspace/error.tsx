"use client";

import { RouteError } from "@/components/route-error";
import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { SidebarInset } from "@/components/ui/sidebar";

/**
 * The Workspace layout itself threw — its read failed — so this renders
 * beside the sidebar, where the Workspace header would be.
 */
export default function WorkspaceError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <SidebarInset id={MAIN_CONTENT_ID} className="min-w-0">
      <RouteError error={error} retry={retry} source="segment" />
    </SidebarInset>
  );
}
