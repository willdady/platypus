"use client";

import { useParams, usePathname } from "next/navigation";
import { SettingsShell } from "@/components/settings-shell";
import { BackButton } from "@/components/back-button";
import { HeaderHomeButton } from "@/components/header-home-button";
import { OrgHome } from "@/components/org-home";
import { OrgListSidebar } from "@/components/org-list-sidebar";
import { resourcePageLayout } from "@/components/resource-page";
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

// Stands in for the Create Workspace page and the first step of its wizard,
// placeholder for placeholder, so nothing jumps when the wizard arrives.
const CreateWorkspaceSkeleton = () => (
  <div className="h-dvh overflow-y-auto pb-4">
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading workspace setup"
      className={resourcePageLayout.wide.outer}
    >
      <div className={resourcePageLayout.wide.inner}>
        <Skeleton className="mb-8 h-8 w-20" />
        <Skeleton className="mb-4 h-8 w-56" />
        <div className="mb-8 flex flex-wrap gap-x-6 gap-y-2">
          {Array.from({ length: 3 }, (_, i) => (
            <div
              key={i}
              data-testid="step-placeholder"
              className="flex items-center gap-2"
            >
              <Skeleton className="size-6 rounded-full" />
              <Skeleton className="h-5 w-16" />
            </div>
          ))}
        </div>
        <div className="mb-6 flex flex-col gap-7">
          {/* Name, Owner and Context, with their descriptions */}
          {[
            { input: "h-9" },
            { input: "h-9", description: "h-5 w-3/4" },
            { input: "h-16", description: "h-10 w-full" },
          ].map(({ input, description }, i) => (
            <div key={i} className="flex flex-col gap-3">
              <Skeleton className="h-4 w-20" />
              <Skeleton className={`${input} w-full`} />
              {description && <Skeleton className={description} />}
            </div>
          ))}
        </div>
        <Skeleton className="h-9 w-16" />
      </div>
    </div>
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
  const { orgId } = useParams<{ orgId: string }>();
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
    return <CreateWorkspaceSkeleton />;
  }

  // The Organization home draws itself: it reads only client-cached data, so
  // a switch between Organizations repaints nothing, and a cold entry shows
  // the home's own placeholders.
  return (
    <SettingsShell
      menu={<OrgListSidebar currentOrgId={orgId} />}
      headerLeft={<HeaderHomeButton />}
      columnWidth="narrow"
      menuWidth="wide"
      contentClassName="px-3"
    >
      <OrgHome orgId={orgId} />
    </SettingsShell>
  );
}
