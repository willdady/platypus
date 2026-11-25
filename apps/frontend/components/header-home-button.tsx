import { appRoutes } from "@/lib/routes";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Home } from "lucide-react";

type HeaderHomeButtonProps = {
  href?: string;
  label?: string;
};

export function HeaderHomeButton({
  href = appRoutes.home,
  label = "Home",
}: HeaderHomeButtonProps) {
  return (
    <Button variant="ghost" size="icon-xs" aria-label={label} asChild>
      <Link href={href}>
        <Home />
      </Link>
    </Button>
  );
}
