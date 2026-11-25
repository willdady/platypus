"use client";

import type { ReactNode } from "react";
import { ListError } from "@/components/list-state";
import { LoadingRegion } from "@/components/list-skeletons";

export function TableList({
  isLoading,
  data,
  error,
  subject,
  skeleton,
  empty,
  isEmpty,
  onRetry,
  children,
}: {
  isLoading: boolean;
  data: unknown;
  error: unknown;
  subject: string;
  skeleton: ReactNode;
  empty: ReactNode;
  isEmpty: boolean;
  onRetry?: () => void;
  children: ReactNode;
}) {
  if (isLoading) {
    return (
      <LoadingRegion label={`Loading ${subject}`}>{skeleton}</LoadingRegion>
    );
  }

  if (error && !data) {
    return <ListError error={error} subject={subject} onRetry={onRetry} />;
  }

  if (data && isEmpty) {
    return <>{empty}</>;
  }

  return <>{children}</>;
}
