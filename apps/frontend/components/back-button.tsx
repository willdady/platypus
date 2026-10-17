"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ArrowLeft } from "lucide-react";

type BackButtonProps = {
  /**
   * Where to land when there is no browser history to go back to (a direct
   * link). Omitted for the header variant, which only ever steps back.
   */
  fallbackHref?: string;
  /** `page` is the labelled button above a resource page; `header` is the icon button in a shell header. */
  variant?: "page" | "header";
  /** Merged onto the `page` variant's button. */
  className?: string;
};

export function BackButton({
  fallbackHref,
  variant = "page",
  className,
}: BackButtonProps) {
  const router = useRouter();

  const handleClick = () => {
    // If there's no history (e.g. direct link), go to fallback
    // Otherwise go back
    if (fallbackHref && window.history.length <= 1) {
      router.push(fallbackHref);
    } else {
      router.back();
    }
  };

  if (variant === "header") {
    return (
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={handleClick}
        aria-label="Back"
      >
        <ArrowLeft />
      </Button>
    );
  }

  return (
    <Button
      className={cn("mb-8", className)}
      variant="outline"
      size="sm"
      onClick={handleClick}
    >
      <ArrowLeft /> Back
    </Button>
  );
}
