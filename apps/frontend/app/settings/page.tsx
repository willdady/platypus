"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/components/auth-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Pencil } from "lucide-react";

const UserSettingsPage = () => {
  const { user, authClient } = useAuth();
  const [name, setName] = useState(user?.name || "");
  const [isEditing, setIsEditing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (user?.name) {
      setName(user.name);
    }
  }, [user?.name]);

  if (!user) return null;

  const handleUpdateName = async () => {
    if (!name.trim()) {
      toast.error("Name cannot be empty");
      return;
    }

    setIsLoading(true);
    try {
      const { error } = await authClient.updateUser({
        name: name.trim(),
      });

      if (error) {
        toast.error(error.message || "Failed to update name");
      } else {
        toast.success("Name updated successfully");
        setIsEditing(false);
      }
    } catch (err) {
      toast.error("An unexpected error occurred");
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Profile Settings</h1>
      <div className="grid grid-cols-1 gap-6 mb-4 max-w-md">
        <div className="space-y-2">
          <Label htmlFor="name" className="text-sm text-muted-foreground">
            Name
          </Label>
          {isEditing ? (
            <div className="flex gap-2">
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={isLoading}
                autoFocus
                onFocus={(e) => e.target.select()}
              />
              <Button
                onClick={handleUpdateName}
                disabled={isLoading || name.trim() === user.name}
                className="cursor-pointer"
              >
                {isLoading ? "Saving..." : "Save"}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setIsEditing(false);
                  setName(user.name);
                }}
                disabled={isLoading}
                className="cursor-pointer"
              >
                Cancel
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-between group">
              <p className="font-medium">{user.name}</p>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setIsEditing(true)}
                className="cursor-pointer"
              >
                <Pencil className="w-4 h-4" />
              </Button>
            </div>
          )}
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
