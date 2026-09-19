import { type ReactNode } from "react";
import { SidebarProvider } from "@/components/ui/sidebar";
import { Header } from "@/components/header";
import { cn } from "@/lib/utils";

type ColumnWidth = "narrow" | "wide";
type MenuWidth = "narrow" | "wide";

const columnWidthClass: Record<ColumnWidth, string> = {
  narrow: "lg:w-4/5 max-w-3xl",
  wide: "lg:w-4/5 max-w-5xl",
};

const menuWidthClass: Record<MenuWidth, { width: string; offset: string }> = {
  narrow: { width: "md:w-48", offset: "md:ml-48" },
  wide: { width: "md:w-64", offset: "md:ml-64" },
};

export interface SettingsColumnsProps {
  /** The navigation column, fixed beside the content at `md` and up. */
  menu: ReactNode;
  children: ReactNode;
  columnWidth?: ColumnWidth;
  menuWidth?: MenuWidth;
  /** Padding and spacing for the content column — the one axis that genuinely differs per surface. */
  contentClassName?: string;
}

/**
 * The menu column + content column every settings-like surface shares. The
 * outer chrome — sidebar provider, header, scroll container — lives in
 * {@link SettingsShell}; the Workspace settings layout uses this directly
 * because the Workspace shell already provides that chrome.
 */
export function SettingsColumns({
  menu,
  children,
  columnWidth = "wide",
  menuWidth = "narrow",
  contentClassName,
}: SettingsColumnsProps) {
  return (
    <div
      className={cn(
        "flex flex-col md:flex-row w-full py-8 px-4 md:px-0",
        columnWidthClass[columnWidth],
      )}
    >
      <div
        className={cn(
          "w-full pt-4 mb-8 md:mb-0 md:fixed md:top-16",
          menuWidthClass[menuWidth].width,
        )}
      >
        {menu}
      </div>
      <div
        className={cn(
          "flex-1 min-w-0",
          menuWidthClass[menuWidth].offset,
          contentClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
}

export interface SettingsShellProps extends SettingsColumnsProps {
  headerLeft?: ReactNode;
}

/**
 * The full-height settings chrome: sidebar provider, header, and the centered
 * scroll container around {@link SettingsColumns}. Backs the Organization,
 * user, and home layouts; `ProtectedRoute` stays at each call site.
 */
export function SettingsShell({ headerLeft, ...columns }: SettingsShellProps) {
  return (
    <SidebarProvider>
      <div className="h-dvh flex flex-col w-full overflow-hidden">
        <Header leftContent={headerLeft} />
        <div className="flex-1 flex flex-col items-center overflow-y-auto">
          <SettingsColumns {...columns} />
          <div className="h-1 shrink-0" />
        </div>
      </div>
    </SidebarProvider>
  );
}
