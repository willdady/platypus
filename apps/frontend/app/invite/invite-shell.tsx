import { cn } from "@/lib/utils";

/**
 * The centered card every invitation state renders inside. `className` sets
 * the spacing and text alignment that differ between states.
 */
export function InviteShell({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className={cn("w-full max-w-md p-8", className)}>{children}</div>
    </div>
  );
}
