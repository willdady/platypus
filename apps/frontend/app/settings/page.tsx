"use client";

import { useState } from "react";
import { useResetOnChange } from "@/hooks/use-reset-on-change";
import { useAuth } from "@/components/auth-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TimezoneCombobox } from "@/components/timezone-combobox";
import { getBrowserTimezone } from "@/lib/timezones";
import { toast } from "sonner";
import { Pencil } from "lucide-react";

const UserSettingsPage = () => {
  const { user, authClient } = useAuth();
  const [name, setName] = useState(user?.name || "");
  const [isEditing, setIsEditing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const savedTimezone = user?.timezone ?? null;
  const [timezone, setTimezone] = useState<string | null>(savedTimezone);
  const [isSavingTimezone, setIsSavingTimezone] = useState(false);
  const detectedTimezone = getBrowserTimezone();

  useResetOnChange(user?.name, () => {
    if (user?.name) {
      setName(user.name);
    }
  });

  useResetOnChange(savedTimezone, () => setTimezone(savedTimezone));

  if (!user) return null;

  const handleSaveTimezone = async () => {
    setIsSavingTimezone(true);
    try {
      const { error } = await authClient.updateUser({ timezone });
      if (error) {
        toast.error(error.message || "Failed to update timezone");
      } else {
        toast.success("Timezone updated successfully");
      }
    } catch (err) {
      toast.error("An unexpected error occurred");
      console.error(err);
    } finally {
      setIsSavingTimezone(false);
    }
  };

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
                aria-label="Edit name"
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
        <div className="space-y-2">
          <Label htmlFor="timezone" className="text-sm text-muted-foreground">
            Timezone
          </Label>
          <TimezoneCombobox
            id="timezone"
            value={timezone}
            onChange={setTimezone}
            disabled={isSavingTimezone}
          />
          <p className="text-sm text-muted-foreground">
            Agents use this to read times like &apos;tomorrow at 9&apos;. If
            it&apos;s not set, Agents aren&apos;t told your timezone.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => setTimezone(detectedTimezone)}
              disabled={isSavingTimezone}
              className="cursor-pointer"
            >
              Use detected ({detectedTimezone})
            </Button>
            <Button
              variant="ghost"
              aria-label="Clear timezone"
              onClick={() => setTimezone(null)}
              disabled={isSavingTimezone || timezone === null}
              className="cursor-pointer"
            >
              Clear
            </Button>
            <Button
              aria-label="Save timezone"
              onClick={handleSaveTimezone}
              disabled={isSavingTimezone || timezone === savedTimezone}
              className="cursor-pointer"
            >
              {isSavingTimezone ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default UserSettingsPage;
