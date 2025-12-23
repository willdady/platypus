"use client";

import { useAuth } from "@/components/auth-provider";

const UserSettingsPage = () => {
  const { user } = useAuth();

  if (!user) return null;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Profile Settings</h1>
      <div className="grid grid-cols-1 gap-6 mb-4 max-w-md">
        <div>
          <p className="text-sm text-muted-foreground mb-1">Name</p>
          <p className="font-medium">{user.name}</p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground mb-1">Email</p>
          <p className="font-medium">{user.email}</p>
        </div>
      </div>
    </div>
  );
};

export default UserSettingsPage;
