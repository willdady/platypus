import { Loader2 } from "lucide-react";

// Fades in after 300ms, so a fast load never flashes it.
export function PageSpinner() {
  return (
    <div className="flex min-h-screen flex-1 items-center justify-center animate-in fade-in fill-mode-both delay-300">
      <Loader2
        role="status"
        aria-label="Loading"
        className="size-8 animate-spin text-muted-foreground"
      />
    </div>
  );
}
