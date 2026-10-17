import { appRoutes } from "@/lib/routes";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Home } from "lucide-react";

export function HeaderHomeButton() {
  return (
    <Button variant="ghost" size="icon-xs" aria-label="Home" asChild>
      <Link href={appRoutes.home}>
        <Home />
      </Link>
    </Button>
  );
}
