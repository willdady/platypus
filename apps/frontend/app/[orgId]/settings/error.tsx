"use client";

import { RouteError, type ErrorBoundaryProps } from "@/components/route-error";

/** An Organization settings page that threw, shown inside the settings shell. */
export default function OrgSettingsError({ error, retry }: ErrorBoundaryProps) {
  return <RouteError error={error} retry={retry} source="segment" />;
}
