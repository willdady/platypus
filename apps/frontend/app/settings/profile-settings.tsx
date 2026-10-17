"use client";

import { useState } from "react";
import { useResetOnChange } from "@/hooks/use-reset-on-change";
import { useEntityForm } from "@/hooks/use-entity-form";
import { useAuth, useAuthClient } from "@/components/auth-provider";
import type { WriteOutcome } from "@/lib/api-write";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TimezoneCombobox } from "@/components/timezone-combobox";
import { getBrowserTimezone } from "@/lib/timezones";
import { toast } from "sonner";
import { Pencil } from "lucide-react";

// `updateUser` is an auth-client call, not a REST write — mapped onto the
// shared outcome shape so the form hook can drive it.
function toOutcome(
  error: { message?: string } | null,
  fallback: string,
): WriteOutcome<unknown> {
  return error
    ? { outcome: "error", message: error.message || fallback }
    : { outcome: "success", data: {}, revalidateKeys: [] };
}

function UserSettingsPage() {
  const { user } = useAuth();
  const authClient = useAuthClient();
  const [isEditing, setIsEditing] = useState(false);

  const savedTimezone = user?.timezone ?? null;
  const detectedTimezone = getBrowserTimezone();

  const nameForm = useEntityForm<{ name: string }>({
    initialData: { name: user?.name || "" },
    entity: "users/me",
    scope: {},
    write: async ({ name }) =>
      toOutcome(
        (await authClient.updateUser({ name: name.trim() })).error,
        "Failed to update name",
      ),
    successMessage: "Name updated successfully",
    onSuccess: () => setIsEditing(false),
  });
  const name = nameForm.formData.name;
  const setName = (value: string) => nameForm.setField("name", value);

  const timezoneForm = useEntityForm<{ timezone: string | null }>({
    initialData: { timezone: savedTimezone },
    entity: "users/me",
    scope: {},
    write: async ({ timezone }) =>
      toOutcome(
        (await authClient.updateUser({ timezone })).error,
        "Failed to update timezone",
      ),
    successMessage: "Timezone updated successfully",
  });
  const timezone = timezoneForm.formData.timezone;
  const setTimezone = (value: string | null) =>
    timezoneForm.setField("timezone", value);

  useResetOnChange(user?.name, () => {
    if (user?.name) {
      nameForm.seedFormData({ name: user.name });
    }
  });

  useResetOnChange(savedTimezone, () =>
    timezoneForm.seedFormData({ timezone: savedTimezone }),
  );

  if (!user) return null;

  const isLoading = nameForm.isSubmitting;
  const isSavingTimezone = timezoneForm.isSubmitting;

  const handleUpdateName = async () => {
    if (!name.trim()) {
      toast.error("Name cannot be empty");
      return;
    }
    await nameForm.submit();
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Profile Settings</h1>
      <div className="grid grid-cols-1 gap-6 mb-4 max-w-md">
        <div className="flex flex-col gap-2">
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
              >
                <Pencil />
              </Button>
            </div>
          )}
        </div>
        <div>
          <p className="text-sm text-muted-foreground mb-1">Email</p>
          <p className="font-medium">{user.email}</p>
        </div>
        <div className="flex flex-col gap-2">
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
            >
              Use detected ({detectedTimezone})
            </Button>
            <Button
              variant="ghost"
              aria-label="Clear timezone"
              onClick={() => setTimezone(null)}
              disabled={isSavingTimezone || timezone === null}
            >
              Clear
            </Button>
            <Button
              aria-label="Save timezone"
              onClick={() => timezoneForm.submit()}
              disabled={isSavingTimezone || timezone === savedTimezone}
            >
              {isSavingTimezone ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default UserSettingsPage;
