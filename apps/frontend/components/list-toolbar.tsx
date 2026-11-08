import type { ReactNode } from "react";

/**
 * A list's filter controls in one wrapping row.
 *
 * It carries no space below: the parent supplies that, as the Workspace home's
 * sections do with their `gap-4`.
 */
export function ListToolbar({ children }: { children: ReactNode }) {
  return (
    <div
      data-slot="list-toolbar"
      className="flex flex-wrap items-center gap-x-4 gap-y-2"
    >
      {children}
    </div>
  );
}
