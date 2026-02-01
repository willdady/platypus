"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Home } from "lucide-react";

export function HeaderHomeButton() {
  const router = useRouter();

  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7"
      onClick={() => router.push("/")}
    >
      <Home className="size-4" />
    </Button>
  );
}
