import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { cn } from "@/lib/utils";

export function InviteShell({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <main
      id={MAIN_CONTENT_ID}
      className="flex min-h-screen items-center justify-center"
    >
      <div className={cn("w-full max-w-md p-8", className)}>{children}</div>
    </main>
  );
}
