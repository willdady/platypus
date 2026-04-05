"use client";

import {
  Field,
  FieldLabel,
  FieldGroup,
  FieldSet,
  FieldError,
  FieldDescription,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  type MessagingChannel,
  type MessagingPairing,
} from "@platypus/schemas";
import { fetcher, parseValidationErrors, joinUrl } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import { Trash2, UserMinus } from "lucide-react";
import { toast } from "sonner";
import useSWR, { useSWRConfig } from "swr";

interface MessagingChannelFormProps {
  orgId: string;
  workspaceId: string;
  channelId?: string;
}

const MessagingChannelForm = ({
  orgId,
  workspaceId,
  channelId,
}: MessagingChannelFormProps) => {
  const { user } = useAuth();
  const backendUrl = useBackendUrl();
  const router = useRouter();
  const { mutate: globalMutate } = useSWRConfig();
  const hasInitialized = useRef(false);

  const [formData, setFormData] = useState({
    type: "telegram" as const,
    botToken: "",
    enabled: true,
  });
  const [pairingCode, setPairingCode] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [validationErrors, setValidationErrors] = useState<
    Record<string, string>
  >({});

  const baseUrl = joinUrl(
    backendUrl,
    `/organizations/${orgId}/workspaces/${workspaceId}/messaging`,
  );

  // Fetch existing channel if editing
  const { data: channel, mutate } = useSWR<MessagingChannel>(
    channelId && user ? joinUrl(baseUrl, `/channels/${channelId}`) : null,
    fetcher,
  );

  // Fetch pairings
  const { data: pairingsData, mutate: mutatePairings } = useSWR<{
    results: MessagingPairing[];
  }>(channelId && user ? joinUrl(baseUrl, `/pairings`) : null, fetcher);
  const pairings = pairingsData?.results ?? [];

  useEffect(() => {
    if (channel && !hasInitialized.current) {
      hasInitialized.current = true;
      setFormData({
        type: channel.type as "telegram",
        botToken: "", // Don't pre-fill the masked token
        enabled: channel.enabled,
      });
    }
  }, [channel]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setValidationErrors({});

    try {
      const method = channelId ? "PATCH" : "POST";
      const url = channelId
        ? joinUrl(baseUrl, `/channels/${channelId}`)
        : joinUrl(baseUrl, `/channels`);

      // Build payload
      const payload: Record<string, unknown> = {};

      if (channelId) {
        // Update: only include changed fields
        if (formData.botToken) {
          payload.config = { botToken: formData.botToken };
        }
        payload.enabled = formData.enabled;
      } else {
        // Create
        payload.type = formData.type;
        payload.config = { botToken: formData.botToken };
        payload.enabled = formData.enabled;
      }

      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        credentials: "include",
      });

      if (response.ok) {
        toast.success(channelId ? "Channel updated" : "Channel created");
        globalMutate(joinUrl(baseUrl, "/channels"));
        if (channelId) {
          mutate();
        } else {
          router.push(`/${orgId}/workspace/${workspaceId}/settings/messaging`);
        }
      } else {
        const errorData = await response.json();
        if (response.status === 422) {
          setValidationErrors(parseValidationErrors(errorData));
        } else {
          toast.error(errorData.message || "Failed to save channel");
        }
      }
    } catch (error) {
      console.error("Error saving channel:", error);
      toast.error("Error saving channel");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!channelId) return;
    setIsDeleting(true);

    try {
      const response = await fetch(joinUrl(baseUrl, `/channels/${channelId}`), {
        method: "DELETE",
        credentials: "include",
      });

      if (response.ok) {
        toast.success("Channel deleted");
        router.push(`/${orgId}/workspace/${workspaceId}/settings/messaging`);
      } else {
        const errorData = await response.json();
        toast.error(errorData.message || "Failed to delete channel");
      }
    } catch {
      toast.error("Error deleting channel");
    } finally {
      setIsDeleting(false);
      setIsDeleteDialogOpen(false);
    }
  };

  const handleConfirmPairing = async () => {
    if (!pairingCode.trim()) return;
    setIsSubmitting(true);

    try {
      const response = await fetch(joinUrl(baseUrl, "/pairings/confirm"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: pairingCode.trim().toUpperCase() }),
        credentials: "include",
      });

      if (response.ok) {
        toast.success("Account linked successfully");
        setPairingCode("");
        mutatePairings();
      } else {
        const errorData = await response.json();
        toast.error(errorData.message || "Failed to confirm pairing");
      }
    } catch {
      toast.error("Error confirming pairing");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRevokePairing = async (pairingId: string) => {
    try {
      const response = await fetch(joinUrl(baseUrl, `/pairings/${pairingId}`), {
        method: "DELETE",
        credentials: "include",
      });

      if (response.ok) {
        toast.success("Pairing revoked");
        mutatePairings();
      } else {
        toast.error("Failed to revoke pairing");
      }
    } catch {
      toast.error("Error revoking pairing");
    }
  };

  return (
    <div>
      <form onSubmit={handleSubmit}>
        <FieldSet className="mb-6">
          <FieldGroup>
            {!channelId && (
              <Field>
                <FieldLabel>Type</FieldLabel>
                <Input value="Telegram" disabled />
                <FieldDescription>
                  The messaging platform for this channel.
                </FieldDescription>
              </Field>
            )}

            <Field data-invalid={!!validationErrors.botToken}>
              <FieldLabel htmlFor="botToken">Bot Token</FieldLabel>
              <Input
                id="botToken"
                type="password"
                placeholder={
                  channelId
                    ? "Enter new token to change"
                    : "Enter your Telegram bot token"
                }
                value={formData.botToken}
                onChange={(e) =>
                  setFormData({ ...formData, botToken: e.target.value })
                }
                disabled={isSubmitting}
              />
              <FieldDescription>
                Get a bot token from{" "}
                <a
                  href="https://t.me/BotFather"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  @BotFather
                </a>{" "}
                on Telegram.
              </FieldDescription>
              {validationErrors.botToken && (
                <FieldError>{validationErrors.botToken}</FieldError>
              )}
            </Field>

            {channelId && (
              <Field>
                <div className="flex items-center space-x-2">
                  <Switch
                    id="enabled"
                    checked={formData.enabled}
                    onCheckedChange={(checked) =>
                      setFormData({ ...formData, enabled: checked })
                    }
                    disabled={isSubmitting}
                  />
                  <Label htmlFor="enabled">Enabled</Label>
                </div>
                <FieldDescription>
                  When enabled, the bot will start listening for messages.
                </FieldDescription>
              </Field>
            )}
          </FieldGroup>
        </FieldSet>

        <div className="flex gap-2">
          <Button
            type="submit"
            disabled={isSubmitting || (!channelId && !formData.botToken)}
          >
            {channelId ? "Update" : "Create"}
          </Button>

          {channelId && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsDeleteDialogOpen(true)}
              disabled={isSubmitting}
            >
              <Trash2 /> Delete
            </Button>
          )}
        </div>
      </form>

      {channelId && (
        <>
          <div className="mt-8 border-t pt-6">
            <h2 className="text-lg font-semibold mb-4">Confirm Pairing</h2>
            <p className="text-sm text-muted-foreground mb-3">
              Enter the 6-character code displayed in Telegram to link your
              account.
            </p>
            <div className="flex gap-2 max-w-sm">
              <Input
                placeholder="ABC123"
                value={pairingCode}
                onChange={(e) => setPairingCode(e.target.value)}
                maxLength={6}
                className="font-mono uppercase"
              />
              <Button
                onClick={handleConfirmPairing}
                disabled={isSubmitting || pairingCode.length !== 6}
              >
                Confirm
              </Button>
            </div>
          </div>

          <div className="mt-8 border-t pt-6">
            <h2 className="text-lg font-semibold mb-4">Paired Users</h2>
            {pairings.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No users have been paired yet.
              </p>
            ) : (
              <ul className="space-y-2">
                {pairings.map((pairing) => (
                  <li
                    key={pairing.id}
                    className="flex items-center justify-between rounded-md border p-3"
                  >
                    <div>
                      <span className="font-medium">
                        {pairing.externalUsername
                          ? `@${pairing.externalUsername}`
                          : `User ${pairing.externalUserId}`}
                      </span>
                      {pairing.pairedAt && (
                        <span className="text-sm text-muted-foreground ml-2">
                          Paired{" "}
                          {new Date(pairing.pairedAt).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRevokePairing(pairing.id)}
                    >
                      <UserMinus className="h-4 w-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      <Dialog
        open={isDeleteDialogOpen}
        onOpenChange={(open) => {
          if (!isDeleting) setIsDeleteDialogOpen(open);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete Channel</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this messaging channel? All paired
              users and chat sessions will be removed. This action cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsDeleteDialogOpen(false)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={isDeleting}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export { MessagingChannelForm };
