"use client";

import { RouteError } from "@/components/route-error";

/**
 * Catches a page outside any shell that has its own boundary. The Workspace
 * and Organization settings segments each have one, so an error there keeps
 * the sidebar and header.
 */
export default function RootError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return <RouteError error={error} retry={retry} source="segment" />;
}
