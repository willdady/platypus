"use client";

import { RouteError, type ErrorBoundaryProps } from "@/components/route-error";

/** A Workspace page that threw, shown under the Workspace header and sidebar. */
export default function WorkspacePageError({
  error,
  retry,
}: ErrorBoundaryProps) {
  return <RouteError error={error} retry={retry} source="segment" />;
}
