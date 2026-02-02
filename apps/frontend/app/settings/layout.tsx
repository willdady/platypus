import { UserSettingsMenu } from "@/components/user-settings-menu";
import { ProtectedRoute } from "@/components/protected-route";
import { SidebarProvider } from "@/components/ui/sidebar";
import { HeaderBackButton } from "@/components/header-back-button";
import { HeaderHomeButton } from "@/components/header-home-button";
import { Header } from "@/components/header";

export default function UserSettingsLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ProtectedRoute>
      <SidebarProvider>
        <div className="h-screen flex flex-col w-full overflow-hidden">
          <Header
            leftContent={
              <div className="flex items-center gap-2">
                <HeaderBackButton />
                <HeaderHomeButton />
              </div>
            }
          />
          <div className="flex-1 flex flex-col items-center overflow-y-auto">
            <div className="flex flex-col md:flex-row w-full md:w-full lg:w-4/5 max-w-5xl py-8 px-4 md:px-0">
              <div className="w-full md:w-48 md:fixed md:top-16 pt-4 mb-8 md:mb-0">
                <UserSettingsMenu />
              </div>
              <div className="flex-1 p-2 md:ml-48">{children}</div>
            </div>
            <div className="h-1 shrink-0" />
          </div>
        </div>
      </SidebarProvider>
    </ProtectedRoute>
  );
}
