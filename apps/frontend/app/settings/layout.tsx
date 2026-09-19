import { UserSettingsMenu } from "@/components/user-settings-menu";
import { ProtectedRoute } from "@/components/protected-route";
import { SettingsShell } from "@/components/settings-shell";
import { BackButton } from "@/components/back-button";
import { HeaderHomeButton } from "@/components/header-home-button";

export default function UserSettingsLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ProtectedRoute>
      <SettingsShell
        menu={<UserSettingsMenu />}
        headerLeft={
          <div className="flex items-center gap-2">
            <BackButton variant="header" />
            <HeaderHomeButton />
          </div>
        }
        contentClassName="p-2"
      >
        {children}
      </SettingsShell>
    </ProtectedRoute>
  );
}
