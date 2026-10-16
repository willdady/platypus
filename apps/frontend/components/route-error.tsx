"use client";

import { useEffect, type ComponentProps } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyCard } from "@/components/empty-card";
import { reportClientError, type ErrorSource } from "@/lib/error-reporting";

/** The props Next.js passes an `error.tsx` or `global-error.tsx` boundary. */
export type ErrorBoundaryProps = {
  error: Error & { digest?: string };
  /**
   * Re-fetches and re-renders the segment. `reset` would only re-render it,
   * so an error a Server Component threw on a failed read would come
   * straight back.
   */
  retry: () => void;
};

/** A fallback card centred in the content area a failed or missing page left. */
export const RouteFallback = (props: ComponentProps<typeof EmptyCard>) => (
  <div className="flex min-h-[50vh] items-center justify-center p-4">
    <EmptyCard className="max-w-md" {...props} />
  </div>
);

/**
 * What an `error.tsx` boundary shows in place of the page that threw. Placed
 * per segment, it renders inside that segment's layout, so the sidebar and
 * header stay put and only the content area is replaced.
 */
export const RouteError = ({
  error,
  retry,
  source,
}: ErrorBoundaryProps & { source: ErrorSource }) => {
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
};
