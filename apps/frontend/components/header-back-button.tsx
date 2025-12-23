"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

export function HeaderBackButton() {
  const router = useRouter();

  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7 cursor-pointer"
      onClick={() => router.back()}
    >
      <ArrowLeft className="size-4" />
    </Button>
  );
}
