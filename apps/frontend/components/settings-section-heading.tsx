import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The one class every settings page gives its section `<h2>`s. */
export const settingsSectionHeadingClass = "text-lg font-semibold mb-3";

/** The heading for one section of a settings page. */
export function SettingsSectionHeading({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <h2 className={cn(settingsSectionHeadingClass, className)}>{children}</h2>
  );
}
