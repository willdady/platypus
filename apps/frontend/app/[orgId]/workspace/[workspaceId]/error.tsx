"use client";

import { RouteError } from "@/components/route-error";

/** A Workspace page that threw, shown under the Workspace header and sidebar. */
export default function WorkspacePageError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return <RouteError error={error} retry={retry} source="segment" />;
}
