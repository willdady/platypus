import { Header } from "@/components/header";
import { HeaderHomeButton } from "@/components/header-home-button";
import { OrgListSidebar } from "@/components/org-list-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";

export default async function OrgHomeLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  return (
    <SidebarProvider>
      <div className="h-screen flex flex-col w-full overflow-hidden">
        <Header leftContent={<HeaderHomeButton />} />
        <div className="flex-1 flex flex-col items-center overflow-y-auto">
          <div className="flex flex-col md:flex-row w-full md:w-full lg:w-4/5 max-w-3xl py-8 px-4 md:px-0">
            {/* Fixed sidebar on desktop */}
            <div className="w-full md:w-64 md:fixed md:top-16 pt-3.5 mb-8 md:mb-0">
              <OrgListSidebar currentOrgId={orgId} />
            </div>
            {/* Content area with left margin to account for fixed sidebar */}
            <div className="flex-1 px-3 md:ml-64">{children}</div>
          </div>
          <div className="h-1 shrink-0" />
        </div>
      </div>
    </SidebarProvider>
  );
}
