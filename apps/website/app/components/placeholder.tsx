import type { FC } from "react";
import { ImageIcon } from "lucide-react";

// Stand-in for app screenshots until real images are dropped in. Renders a
// muted, dashed-border frame with a centred label so it reads clearly as a
// placeholder. Swap each usage for a <Image> / <img> when screenshots exist.
export const Placeholder: FC<{
  label: string;
  /** Tailwind aspect-ratio utility, e.g. "aspect-video" (default) or "aspect-[4/3]". */
  aspect?: string;
  className?: string;
}> = ({ label, aspect = "aspect-video", className = "" }) => (
  <div
    role="img"
    aria-label={`${label} (placeholder)`}
    className={`flex ${aspect} w-full items-center justify-center rounded-xl border border-dashed border-border bg-card/50 ${className}`}
  >
    <div className="flex flex-col items-center gap-3 text-muted-foreground">
      <ImageIcon className="size-8" aria-hidden="true" />
      <span className="text-sm font-medium">{label}</span>
    </div>
  </div>
);
