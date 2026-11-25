import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export const settingsSectionHeadingClass = "text-lg font-semibold mb-3";

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
