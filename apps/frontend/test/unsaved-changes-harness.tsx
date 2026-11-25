import Link from "next/link";
import { vi } from "vitest";

export const elsewhereClicked = vi.fn();

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
