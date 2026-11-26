import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

export type AuthShellProps = {
  className?: string;
  children?: ReactNode;
} & (
  | { title: string; description?: ReactNode }
  | { title?: never; description?: never }
);

// why: PageHeader's start alignment and margins don't fit a centred signed-out card
export function AuthShell({
  title,
  description,
  className,
  children,
}: AuthShellProps) {
  return (
    <main
      id={MAIN_CONTENT_ID}
      className="flex min-h-screen items-center justify-center"
    >
      <div className={cn("w-full max-w-md flex flex-col gap-8 p-8", className)}>
        {title && (
          <div className="text-center">
            <h1 className="text-2xl font-bold">{title}</h1>
            {description && (
              <p className="text-muted-foreground mt-2">{description}</p>
            )}
          </div>
        )}
        {children}
      </div>
    </main>
  );
}
