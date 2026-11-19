import type { ReactNode } from "react";
import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { cn } from "@/lib/utils";

/**
 * The centered card the signed-out screens render inside: sign-in, sign-up and
 * the invitation states. `title` renders the heading block; `className` sets
 * the spacing and text alignment that differ between screens.
 */
export function AuthShell({
  title,
  description,
  className,
  headingClassName,
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
  className?: string;
  /** Spacing between the heading and its description when screens differ. */
  headingClassName?: string;
  children?: ReactNode;
}) {
  return (
    <main
      id={MAIN_CONTENT_ID}
      className="flex min-h-screen items-center justify-center"
    >
      <div className={cn("w-full max-w-md flex flex-col gap-8 p-8", className)}>
        {title && (
          <div className={cn("text-center", headingClassName)}>
            <h1 className="text-2xl font-bold">{title}</h1>
            {description && (
              <p
                className={cn(
                  "text-muted-foreground",
                  !headingClassName && "mt-2",
                )}
              >
                {description}
              </p>
            )}
          </div>
        )}
        {children}
      </div>
    </main>
  );
}
