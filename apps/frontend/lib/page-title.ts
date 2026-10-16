import type { Metadata } from "next";

export const APP_NAME = "Platypus";

/**
 * The title a scoping layout (a Workspace, an Organization's settings) gives
 * the pages inside it: each page's own title, then the scope's name, then the
 * app's. A page that names no title of its own reads as the scope's name.
 *
 * With no name — the read failed — the layout sets no title, so its pages fall
 * back to the root layout's template.
 */
export function scopedTitle(
  scopeName: string | null | undefined,
): Metadata["title"] {
  if (!scopeName) return undefined;
  return {
    default: scopeName,
    template: `%s | ${scopeName} | ${APP_NAME}`,
  };
}

/**
 * A full document title, in the same order route metadata gives one: the
 * page's own name, its scope, then the app. Empty parts are skipped.
 */
export function documentTitle(
  ...parts: Array<string | null | undefined>
): string {
  return [...parts.filter((part) => part?.trim()), APP_NAME].join(" | ");
}
