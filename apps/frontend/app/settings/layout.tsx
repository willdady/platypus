import { UserSettingsMenu } from "@/components/user-settings-menu";
import { ProtectedRoute } from "@/components/protected-route";
import { SidebarProvider } from "@/components/ui/sidebar";
import { HeaderBackButton } from "@/components/header-back-button";
import { Header } from "@/components/header";

export default function UserSettingsLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ProtectedRoute>
      <SidebarProvider>
        <div className="min-h-screen flex flex-col w-full">
          <Header leftContent={<HeaderBackButton />} />
          <div className="flex-1 flex justify-center">
            <div className="flex w-4/5 max-w-3xl py-8">
              <div className="w-48 fixed top-16 pt-4">
                <UserSettingsMenu />
              </div>
              <div className="flex-1 p-2 ml-48 pb-8">{children}</div>
            </div>
          </div>
        </div>
      </SidebarProvider>
    </ProtectedRoute>
  );
}
