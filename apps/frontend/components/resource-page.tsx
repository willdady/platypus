import { type ReactNode } from "react";
import { BackButton } from "@/components/back-button";

export type ResourcePageVariant = "bare" | "narrow" | "stacked" | "wide";

export type ResourcePageProps = {
  backFallbackHref: string;
  title: string;
  children: ReactNode;
  variant?: ResourcePageVariant;
  /** Page-level actions drawn beside the title, e.g. a link elsewhere. */
  actions?: ReactNode;
};

const narrowTitleClass = "text-2xl mb-4 font-bold";
const narrowColumnClass = "w-full px-4 md:px-0 md:w-4/5 xl:w-2/5";

// Exported so a loading fallback can take the same column as the page it stands
// in for.
export const resourcePageLayout: Record<
  ResourcePageVariant,
  { outer?: string; inner: string; title: string; back?: string }
> = {
  bare: { inner: "", title: narrowTitleClass },
  narrow: {
    outer: "flex justify-center pb-8",
    inner: narrowColumnClass,
    title: narrowTitleClass,
  },
  stacked: {
    outer: "flex justify-center pb-8",
    inner: `${narrowColumnClass} flex flex-col gap-8`,
    title: "text-2xl font-bold",
    // The column's gap already spaces the button from the title.
    back: "mb-0 self-start",
  },
  wide: {
    outer: "flex justify-center w-full p-4",
    inner: "w-lg",
    title: narrowTitleClass,
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

  const heading = <h1 className={layout.title}>{title}</h1>;

  const inner = (
    <div className={layout.inner}>
      <BackButton fallbackHref={backFallbackHref} className={layout.back} />
      {actions ? (
        <div className="flex items-start justify-between gap-4">
          {heading}
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        </div>
      ) : (
        heading
      )}
      {children}
    </div>
  );

  if (!layout.outer) {
    return inner;
  }

  return <div className={layout.outer}>{inner}</div>;
}
