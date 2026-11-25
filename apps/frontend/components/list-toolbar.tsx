import type { ReactNode } from "react";

// why: no space below; the parent supplies it, as the Workspace home's gap-4 does
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
