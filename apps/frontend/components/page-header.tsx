import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type PageHeaderProps = {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  titleSpacing?: "default" | "flush";
};

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
        <div
          data-testid="page-header"
          className="flex items-start justify-between gap-4"
        >
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
