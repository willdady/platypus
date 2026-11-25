import { cn } from "@/lib/utils";

// why: announce false on the visual copy, so a screen reader says it once
export function TurnStatus({
  children,
  announce = true,
  className,
}: {
  children: string;
  announce?: boolean;
  className?: string;
}) {
  return (
    <p
      role={announce ? "status" : undefined}
      className={cn("text-xs text-muted-foreground", className)}
    >
      {children}
    </p>
  );
}
