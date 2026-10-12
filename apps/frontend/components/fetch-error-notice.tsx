"use client";

import Link from "next/link";
import { FileQuestion, ShieldX, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyCard } from "@/components/empty-card";
import { errorStatus, isNotFoundOrForbidden } from "@/lib/utils";

const noticeFor = (subject: string, error: unknown) => {
  switch (errorStatus(error)) {
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
 * The notice a failed record read shows in place of the record: what went
 * wrong — gone, forbidden, or anything else — and the way back. Shared by
 * `DetailFormState` and the pages that gate on one record (the Workspace
 * home, `ProtectedRoute`). Given
 * `onRetry` (the read's `mutate`), anything else also offers to read again;
 * a 403 or 404 doesn't, since reading again won't change the answer.
 */
export const FetchErrorNotice = ({
  error,
  subject,
  backHref,
  backLabel,
  onRetry,
}: {
  error: unknown;
  /** What the record is, for the messages: "provider", "workspace". */
  subject: string;
  backHref: string;
  backLabel: string;
  onRetry?: () => void;
}) => {
  const notice = noticeFor(subject, error);
  const retryable = onRetry && !isNotFoundOrForbidden(error);
  return (
    <EmptyCard
      icon={notice.icon}
      title={notice.title}
      description={notice.description}
      action={
        <>
          {retryable && <Button onClick={() => onRetry()}>Retry</Button>}
          <Button asChild variant="outline">
            <Link href={backHref}>{backLabel}</Link>
          </Button>
        </>
      }
    />
  );
};
