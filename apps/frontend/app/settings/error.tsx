"use client";

import { RouteError, type ErrorBoundaryProps } from "@/components/route-error";

/** A User settings page that threw, shown inside the settings shell. */
export default function UserSettingsError({
  error,
  retry,
}: ErrorBoundaryProps) {
  return <RouteError error={error} retry={retry} source="segment" />;
}
