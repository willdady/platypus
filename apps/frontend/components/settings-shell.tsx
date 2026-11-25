import { MAIN_CONTENT_ID } from "@/components/skip-link";
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

export type SettingsColumnsProps = {
  menu: ReactNode;
  children: ReactNode;
  columnWidth?: ColumnWidth;
  menuWidth?: MenuWidth;
  contentClassName?: string;
  // why: a nested <main> is invalid, so an inner shell leaves it to the outer one
  isMain?: boolean;
};

export function SettingsColumns({
  menu,
  children,
  columnWidth = "wide",
  menuWidth = "narrow",
  contentClassName,
  isMain = false,
}: SettingsColumnsProps) {
  const Content = isMain ? "main" : "div";
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
      <Content
        id={isMain ? MAIN_CONTENT_ID : undefined}
        className={cn(
          "flex-1 min-w-0",
          menuWidthClass[menuWidth].offset,
          contentClassName,
        )}
      >
        {children}
      </Content>
    </div>
  );
}

export type SettingsShellProps = {
  headerLeft?: ReactNode;
} & SettingsColumnsProps;

// why: ProtectedRoute stays at each call site, not inside this shell
export function SettingsShell({ headerLeft, ...columns }: SettingsShellProps) {
  return (
    <SidebarProvider>
      <div className="h-dvh flex flex-col w-full overflow-hidden">
        <Header leftContent={headerLeft} />
        <div className="flex-1 flex flex-col items-center overflow-y-auto">
          <SettingsColumns {...columns} isMain />
          <div className="h-1 shrink-0" />
        </div>
      </div>
    </SidebarProvider>
  );
}
