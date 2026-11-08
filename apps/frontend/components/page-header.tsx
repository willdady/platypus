import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type PageHeaderProps = {
  title: ReactNode;
  /** Drawn under the title in muted text; accepts nodes a page fills live. */
  description?: ReactNode;
  /** Page-level actions drawn beside the title, e.g. a link elsewhere. */
  actions?: ReactNode;
  /**
   * `flush` drops the title's own bottom margin where the parent column's gap
   * already spaces it — the `stacked` ResourcePage.
   */
  titleSpacing?: "default" | "flush";
};

/**
 * The title block every settings and list page shares: one `<h1>`, an optional
 * muted description, and optional actions beside the title. Owning the spacing
 * here stops pages drifting apart as you move between screens.
 */
export function PageHeader({
  title,
  description,
  actions,
  titleSpacing = "default",
}: PageHeaderProps) {
  const heading = (
    <h1
      className={cn("text-2xl font-bold", titleSpacing !== "flush" && "mb-4")}
    >
      {title}
    </h1>
  );

  return (
    <>
      {actions ? (
        <div className="flex items-start justify-between gap-4">
          {heading}
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        </div>
      ) : (
        heading
      )}
      {description && (
        <p className="text-muted-foreground mb-6">{description}</p>
      )}
    </>
  );
}
