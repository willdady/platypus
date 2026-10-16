"use client";

import { RouteError, type ErrorBoundaryProps } from "@/components/route-error";

/**
 * Catches a page outside any shell that has its own boundary. The Workspace
 * and Organization settings segments each have one, so an error there keeps
 * the sidebar and header.
 */
export default function RootError({ error, retry }: ErrorBoundaryProps) {
  return <RouteError error={error} retry={retry} source="segment" />;
}
