import { type ReactNode } from "react";
import { BackButton } from "@/components/back-button";
import { PageHeader } from "@/components/page-header";

export type ResourcePageVariant = "bare" | "narrow" | "stacked" | "wide";

export type ResourcePageProps = {
  backFallbackHref?: string;
  title: string;
  children: ReactNode;
  variant?: ResourcePageVariant;
  actions?: ReactNode;
};

const narrowColumnClass = "w-full px-4 md:px-0 md:w-4/5 max-w-3xl";

// why: exported so a loading fallback can take the page's own column
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
