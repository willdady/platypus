"use client";

import { ChangePasswordForm } from "@/components/change-password-form";

const SecuritySettingsPage = () => {
  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Security Settings</h1>
      <div className="max-w-md">
        <h2 className="text-lg font-semibold mb-4">Change Password</h2>
        <ChangePasswordForm />
      </div>
    </div>
  );
};

export default SecuritySettingsPage;
