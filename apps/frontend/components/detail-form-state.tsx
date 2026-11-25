"use client";

import type { ReactNode } from "react";
import { DefaultFormSkeleton } from "@/components/form-skeleton";
import { FetchErrorNotice } from "@/components/fetch-error-notice";

export type DetailFormStateProps = {
  isLoading: boolean;
  error?: unknown;
  data?: unknown;
  subject: string;
  backHref: string;
  backLabel: string;
  skeleton?: ReactNode;
  loadingLabel?: string;
  children: ReactNode;
};

export function DetailFormState({
  isLoading,
  error,
  data,
  subject,
  backHref,
  backLabel,
  skeleton,
  loadingLabel,
  children,
}: DetailFormStateProps) {
  if (isLoading) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label={loadingLabel ?? `Loading ${subject}`}
      >
        {skeleton ?? <DefaultFormSkeleton />}
      </div>
    );
  }

  if (error && !data) {
    return (
      <FetchErrorNotice
        error={error}
        subject={subject}
        backHref={backHref}
        backLabel={backLabel}
      />
    );
  }

  return <>{children}</>;
}
