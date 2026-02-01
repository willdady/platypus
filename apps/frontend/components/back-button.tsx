"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

export function BackButton({ fallbackHref }: { fallbackHref: string }) {
  const router = useRouter();

  return (
    <Button
      className="mb-8"
      variant="outline"
      size="sm"
      onClick={() => {
        // If there's no history (e.g. direct link), go to fallback
        // Otherwise go back
        if (window.history.length <= 1) {
          router.push(fallbackHref);
        } else {
          router.back();
        }
      }}
    >
      <ArrowLeft /> Back
    </Button>
  );
}
