/** The id of the page's `<main>`, which the skip link jumps to. */
export const MAIN_CONTENT_ID = "main-content";

/**
 * The first thing a keyboard user tabs to: a jump past the header and sidebar
 * to the page's own content. Hidden until focused.
 */
export function SkipLink() {
  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:shadow-md focus:outline-none focus:ring-2 focus:ring-ring"
    >
      Skip to content
    </a>
  );
}
