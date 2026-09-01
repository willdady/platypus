import { type ReactNode } from "react";
import { BackButton } from "@/components/back-button";

export type ResourcePageVariant = "plain" | "create" | "settings" | "wide";

export type ResourcePageProps = {
  backFallbackHref: string;
  title: string;
  children: ReactNode;
  variant?: ResourcePageVariant;
};

const narrowTitleClass = "text-2xl mb-4 font-bold";
const narrowColumnClass = "w-full px-4 md:px-0 md:w-4/5 xl:w-2/5";

const layoutByVariant: Record<
  ResourcePageVariant,
  { outer?: string; inner: string; title: string }
> = {
  plain: { inner: "", title: narrowTitleClass },
  create: {
    outer: "flex justify-center pb-8",
    inner: narrowColumnClass,
    title: narrowTitleClass,
  },
  settings: {
    outer: "flex justify-center pb-8",
    inner: `${narrowColumnClass} space-y-8`,
    title: "text-2xl font-bold",
  },
  wide: {
    outer: "flex justify-center w-full p-4",
    inner: "w-lg",
    title: narrowTitleClass,
  },
};

export const ResourcePage = ({
  backFallbackHref,
  title,
  children,
  variant = "plain",
}: ResourcePageProps) => {
  const layout = layoutByVariant[variant];

  const inner = (
    <div className={layout.inner}>
      <BackButton fallbackHref={backFallbackHref} />
      <h1 className={layout.title}>{title}</h1>
      {children}
    </div>
  );

  if (!layout.outer) {
    return inner;
  }

  return <div className={layout.outer}>{inner}</div>;
};
