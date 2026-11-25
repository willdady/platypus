import type { Metadata } from "next";

export const APP_NAME = "Platypus";

export function scopedTitle(
  scopeName: string | null | undefined,
): Metadata["title"] {
  if (!scopeName) return undefined;
  return {
    default: scopeName,
    template: `%s | ${scopeName} | ${APP_NAME}`,
  };
}

export function documentTitle(
  ...parts: Array<string | null | undefined>
): string {
  return [...parts.filter((part) => part?.trim()), APP_NAME].join(" | ");
}
