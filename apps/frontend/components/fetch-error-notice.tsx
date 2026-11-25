"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { FileQuestion, ShieldX, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyCard } from "@/components/empty-card";
import { errorStatus, isNotFoundOrForbidden } from "@/lib/utils";

function noticeFor(subject: string, error: unknown) {
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
}

export function FetchErrorNotice({
  error,
  subject,
  description,
  backHref,
  backLabel,
  onRetry,
}: {
  error: unknown;
  subject: string;
  description?: ReactNode;
  backHref: string;
  backLabel: string;
  onRetry?: () => void;
}) {
  const notice = noticeFor(subject, error);
  const retryable = onRetry && !isNotFoundOrForbidden(error);
  return (
    <EmptyCard
      icon={notice.icon}
      title={notice.title}
      description={description ?? notice.description}
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
}
