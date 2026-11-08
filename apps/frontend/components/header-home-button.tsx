import { appRoutes } from "@/lib/routes";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Home } from "lucide-react";

type HeaderHomeButtonProps = {
  /** Where the button leads. Defaults to the app home. */
  href?: string;
  /** The link's accessible name. Defaults to "Home". */
  label?: string;
};

/** The home button every shell header draws, linking where that shell starts. */
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
