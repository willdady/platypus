import type { Metadata } from "next";
import { ChangePasswordForm } from "@/components/change-password-form";
import { PageHeader } from "@/components/page-header";
import { SettingsSectionHeading } from "@/components/settings-section-heading";

export const metadata: Metadata = { title: "Security Settings" };

function SecuritySettingsPage() {
  return (
    <div>
      <PageHeader title="Security Settings" />
      <div className="max-w-md">
        <SettingsSectionHeading>Change Password</SettingsSectionHeading>
        <ChangePasswordForm />
      </div>
    </div>
  );
}

export default SecuritySettingsPage;
