import Link from "next/link";
import { vi } from "vitest";

/**
 * Whether a guard let a link click through to the link's own handler. The
 * provider holds a click in the capture phase, so the bubble handler only runs
 * when it did not.
 */
export const elsewhereClicked = vi.fn();

/**
 * The link a surface test renders beside the surface under test. `preventDefault`
 * keeps jsdom from warning about a navigation it can't make; it runs in the
 * bubble phase, so the guard's capture listener still sees the click first.
 */
export function GuardLink() {
  return (
    <Link
      href="/elsewhere"
      onClick={(event) => {
        event.preventDefault();
        elsewhereClicked();
      }}
    >
      Elsewhere
    </Link>
  );
}
