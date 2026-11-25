"use client";

import { useEffect, type ComponentProps } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyCard } from "@/components/empty-card";
import { reportClientError, type ErrorSource } from "@/lib/error-reporting";

export type ErrorBoundaryProps = {
  error: Error & { digest?: string };
  // why: reset only re-renders, so a Server Component read would throw again
  retry: () => void;
};

export function RouteFallback(props: ComponentProps<typeof EmptyCard>) {
  return (
    <div className="flex min-h-[50vh] items-center justify-center p-4">
      <EmptyCard className="max-w-md" {...props} />
    </div>
  );
}

export function RouteError({
  error,
  retry,
  source,
}: ErrorBoundaryProps & { source: ErrorSource }) {
  useEffect(() => {
    console.error("Unhandled error:", error);
    reportClientError(
      error,
      error.digest ? { source, digest: error.digest } : { source },
    );
  }, [error, source]);

  return (
    <RouteFallback
      icon={<TriangleAlert />}
      title="Couldn't load this page"
      description="Something went wrong while showing it. Try again in a moment."
      action={<Button onClick={() => retry()}>Try again</Button>}
    />
  );
}
