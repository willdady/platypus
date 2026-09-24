"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { FileQuestion, ShieldX, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { DefaultFormSkeleton } from "@/components/form-skeleton";

export type DetailFormStateProps = {
  /** True while the record is still being read. */
  isLoading: boolean;
  /**
   * The record read's error, if any. A `fetcher` rejection carries the
   * response status, which is what tells a deleted id from a forbidden one.
   */
  error?: unknown;
  /**
   * The record read's data. Absent with an error means the read failed cold;
   * present with one means only a revalidation failed, so the form stays.
   */
  data?: unknown;
  /** What the record is, for the messages: "provider", "MCP server". */
  subject: string;
  backHref: string;
  backLabel: string;
  /**
   * The placeholder shown while loading, shaped like the form it stands in
   * for (built from `form-skeleton` blocks) so the swap doesn't shift the
   * page. Defaults to a generic few-fields skeleton.
   */
  skeleton?: ReactNode;
  /**
   * The loading placeholder's accessible name. Defaults to
   * `Loading {subject}`, which misreads on a create page that is only
   * waiting on the form's own reads.
   */
  loadingLabel?: string;
  children: ReactNode;
};

const statusOf = (error: unknown): number | undefined => {
  if (error && typeof error === "object" && "status" in error) {
    const { status } = error as { status?: unknown };
    if (typeof status === "number") return status;
  }
  return undefined;
};

const noticeFor = (subject: string, error: unknown) => {
  switch (statusOf(error)) {
    case 404:
      return {
        icon: <FileQuestion />,
        title: "Not found",
        description: `This ${subject} no longer exists. It may have been deleted.`,
      };
    case 403:
      return {
        icon: <ShieldX />,
        title: "You don't have access",
        description: `You do not have permission to view this ${subject}.`,
      };
    default:
      return {
        icon: <TriangleAlert />,
        title: "Couldn't load",
        description: `This ${subject} couldn't be loaded. Try again in a moment.`,
      };
  }
};

/**
 * The gate every resource detail form reads its record through: a loading
 * placeholder, then either the form or a failure state that names what went
 * wrong and offers the way back to the list. Without it a deleted id, a 403
 * or a 500 renders a blank *editable* form, and Save then PUTs to a record
 * that isn't there.
 *
 * Create pages pass no `data` and no `error`, so they fall straight through.
 */
export const DetailFormState = ({
  isLoading,
  error,
  data,
  subject,
  backHref,
  backLabel,
  skeleton,
  loadingLabel,
  children,
}: DetailFormStateProps) => {
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
    const notice = noticeFor(subject, error);
    return (
      <Empty className="border-2 border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">{notice.icon}</EmptyMedia>
          <EmptyTitle>{notice.title}</EmptyTitle>
          <EmptyDescription>{notice.description}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild variant="outline">
            <Link href={backHref}>{backLabel}</Link>
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  return <>{children}</>;
};
