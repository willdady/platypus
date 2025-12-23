import { OrgSettingsMenu } from "@/components/org-settings-menu";
import { SidebarProvider } from "@/components/ui/sidebar";
import { Header } from "@/components/header";
import { HeaderBackButton } from "@/components/header-back-button";

export default async function OrgSettingsLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ orgId: string }>;
}>) {
  const { orgId } = await params;

  return (
    <SidebarProvider>
      <div className="min-h-screen flex flex-col w-full">
        <Header leftContent={<HeaderBackButton />} />
        <div className="flex-1 flex justify-center">
          <div className="flex w-4/5 max-w-3xl py-8">
            <div className="w-48 fixed top-16 pt-4">
              <OrgSettingsMenu orgId={orgId} />
            </div>
            <div className="flex-1 p-2 ml-48 pb-8">{children}</div>
          </div>
        </div>
      </div>
    </SidebarProvider>
  );
}
