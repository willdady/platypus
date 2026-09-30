"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  /**
   * Re-fetches and re-renders the segment. `reset` would only re-render it,
   * so an error a Server Component threw on a failed read would come
   * straight back.
   */
  retry: () => void;
}) {
  useEffect(() => {
    console.error("Unhandled error:", error);
  }, [error]);

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 p-4">
      <h2 className="text-xl font-semibold">Something went wrong</h2>
      <p className="text-muted-foreground text-sm">
        An unexpected error occurred. Please try again.
      </p>
      <Button onClick={() => retry()} variant="outline">
        Try again
      </Button>
    </div>
  );
}
