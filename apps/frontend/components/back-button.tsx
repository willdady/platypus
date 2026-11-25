"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ArrowLeft } from "lucide-react";

type BackButtonProps = {
  fallbackHref?: string;
  variant?: "page" | "header";
  className?: string;
};

export function BackButton({
  fallbackHref,
  variant = "page",
  className,
}: BackButtonProps) {
  const router = useRouter();

  const handleClick = () => {
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
