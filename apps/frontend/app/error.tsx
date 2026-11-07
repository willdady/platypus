"use client";

import { RouteError, type ErrorBoundaryProps } from "@/components/route-error";

/**
 * Catches a page outside any shell that has its own boundary. The Workspace,
 * Organization settings and User settings segments each have one, so an error
 * there keeps the shell around it.
 */
export default function RootError({ error, retry }: ErrorBoundaryProps) {
  return <RouteError error={error} retry={retry} source="segment" />;
}
