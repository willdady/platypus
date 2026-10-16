"use client";

import { RouteError } from "@/components/route-error";

/** An Organization settings page that threw, shown inside the settings shell. */
export default function OrgSettingsError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return <RouteError error={error} retry={retry} source="segment" />;
}
