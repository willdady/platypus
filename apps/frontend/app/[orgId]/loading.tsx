"use client";

import { usePathname } from "next/navigation";
import { SettingsShell } from "@/components/settings-shell";
import { BackButton } from "@/components/back-button";
import { HeaderHomeButton } from "@/components/header-home-button";
import { Skeleton } from "@/components/ui/skeleton";
import WorkspaceShellLayout from "./workspace/layout";
import WorkspaceLoading from "./workspace/loading";

const MenuSkeleton = () => (
  <div className="flex flex-col gap-2">
    {Array.from({ length: 8 }, (_, i) => (
      <Skeleton key={i} className="h-8 w-full" />
    ))}
  </div>
);

const ContentSkeleton = () => (
  <div
    role="status"
    aria-busy="true"
    aria-label="Loading organization"
    className="space-y-4"
  >
    <Skeleton className="h-8 w-48" />
    <Skeleton className="h-24 w-full" />
    <Skeleton className="h-24 w-full" />
  </div>
);

// The Organization settings layout awaits the organization on the server, and
// a segment's own `loading` can't cover its layout — so the fallback lives
// here, one segment up. That makes it the boundary for every Organization
// child (home, settings, create, the Workspace shell), and it is what the
// router shows the moment any of them is entered, so it takes the shape of
// the one being entered rather than one shape for all.
export default function OrganizationLoading() {
  const pathname = usePathname();
  const [, , section] = pathname.split("/");

  if (section === "settings") {
    return (
      <SettingsShell
        menu={<MenuSkeleton />}
        headerLeft={
          <div className="flex items-center gap-2">
            <BackButton variant="header" />
            <HeaderHomeButton />
          </div>
        }
        contentClassName="p-2"
      >
        <ContentSkeleton />
      </SettingsShell>
    );
  }

  if (section === "workspace") {
    return (
      <WorkspaceShellLayout>
        <WorkspaceLoading />
      </WorkspaceShellLayout>
    );
  }

  if (section === "create") {
    return (
      <div className="flex justify-center pb-8">
        <div className="w-full px-4 md:w-4/5 md:px-0 xl:w-2/5">
          <ContentSkeleton />
        </div>
      </div>
    );
  }

  // The Organization home.
  return (
    <SettingsShell
      menu={<MenuSkeleton />}
      headerLeft={<HeaderHomeButton />}
      columnWidth="narrow"
      menuWidth="wide"
      contentClassName="px-3"
    >
      <ContentSkeleton />
    </SettingsShell>
  );
}
