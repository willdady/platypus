import { type ReactNode } from "react";
import { BackButton } from "@/components/back-button";
import { PageHeader } from "@/components/page-header";

export type ResourcePageVariant = "bare" | "narrow" | "stacked" | "wide";

export type ResourcePageProps = {
  /**
   * Draws a labelled Back above the title, landing here when there is no
   * history. Omitted inside a Workspace, whose header already holds the Back.
   */
  backFallbackHref?: string;
  title: string;
  children: ReactNode;
  variant?: ResourcePageVariant;
  /** Page-level actions drawn beside the title, e.g. a link elsewhere. */
  actions?: ReactNode;
};

const narrowColumnClass = "w-full px-4 md:px-0 md:w-4/5 max-w-3xl";

// Exported so a loading fallback can take the same column as the page it stands
// in for.
export const resourcePageLayout: Record<
  ResourcePageVariant,
  { outer?: string; inner: string; back?: string }
> = {
  bare: { inner: "" },
  narrow: {
    outer: "flex justify-center py-8",
    inner: narrowColumnClass,
  },
  stacked: {
    outer: "flex justify-center py-8",
    inner: `${narrowColumnClass} flex flex-col gap-8`,
    // The column's gap already spaces the button from the title.
    back: "mb-0 self-start",
  },
  wide: {
    outer: "flex justify-center w-full p-4",
    inner: "w-lg",
  },
};

export function ResourcePage({
  backFallbackHref,
  title,
  children,
  variant = "bare",
  actions,
}: ResourcePageProps) {
  const layout = resourcePageLayout[variant];

  const inner = (
    <div className={layout.inner}>
      {backFallbackHref && (
        <BackButton fallbackHref={backFallbackHref} className={layout.back} />
      )}
      <PageHeader
        title={title}
        actions={actions}
        titleSpacing={variant === "stacked" ? "flush" : "default"}
      />
      {children}
    </div>
  );

  if (!layout.outer) {
    return inner;
  }

  return <div className={layout.outer}>{inner}</div>;
}
