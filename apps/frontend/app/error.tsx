"use client";

import { RouteError, type ErrorBoundaryProps } from "@/components/route-error";

export default function RootError({ error, retry }: ErrorBoundaryProps) {
  return <RouteError error={error} retry={retry} source="segment" />;
}
