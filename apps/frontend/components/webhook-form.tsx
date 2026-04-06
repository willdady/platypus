"use client";

import {
  Field,
  FieldLabel,
  FieldGroup,
  FieldSet,
  FieldDescription,
  FieldError,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { fetcher, parseValidationErrors, joinUrl } from "@/lib/utils";
import { toast } from "sonner";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import {
  Trash2,
  Eye,
  EyeOff,
  Copy,
  RefreshCw,
  Plus,
  X,
} from "lucide-react";

interface Webhook {
  id: string;
  workspaceId: string;
  url: string;
  signingSecret: string;
  headers: Record<string, string> | null;
  enabled: boolean;
  events: string[];
  createdAt: string;
  updatedAt: string;
}

interface WebhookFormProps {
  orgId: string;
  workspaceId: string;
  webhook?: Webhook;
  onMutate: () => void;
}

const WebhookForm = ({ orgId, workspaceId, webhook, onMutate }: WebhookFormProps) => {
  const backendUrl = useBackendUrl();
  const router = useRouter();

  const ALL_EVENTS = [
    "notification.created",
    "notification.updated",
    "notification.read",
    "notification.dismissed",
  ] as const;

  const EVENT_LABELS: Record<string, string> = {
    "notification.created": "Notification created",
    "notification.updated": "Notification updated",
    "notification.read": "Notification read",
    "notification.dismissed": "Notification dismissed",
  };

  const [url, setUrl] = useState(webhook?.url ?? "");
  const [enabled, setEnabled] = useState(webhook?.enabled ?? true);
  const [events, setEvents] = useState<string[]>(
    webhook?.events ?? [...ALL_EVENTS],
  );
  const [headers, setHeaders] = useState<{ key: string; value: string }[]>(() => {
    if (webhook?.headers) {
      return Object.entries(webhook.headers).map(([key, value]) => ({
        key,
        value,
      }));
    }
    return [];
  });

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isRegenerateDialogOpen, setIsRegenerateDialogOpen] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [validationErrors, setValidationErrors] = useState<
    Record<string, string>
  >({});

  const isEditMode = !!webhook;

  const toggleEvent = (event: string) => {
    setEvents((prev) => {
      if (prev.includes(event)) {
        if (prev.length === 1) return prev;
        return prev.filter((e) => e !== event);
      }
      return [...prev, event];
    });
  };

  useEffect(() => {
    if (webhook) {
      setUrl(webhook.url);
      setEnabled(webhook.enabled);
      setEvents(webhook.events ?? [...ALL_EVENTS]);
      if (webhook.headers) {
        setHeaders(
          Object.entries(webhook.headers).map(([key, value]) => ({
            key,
            value,
          })),
        );
      } else {
        setHeaders([]);
      }
    }
  }, [webhook]);

  const webhookBaseUrl = joinUrl(
    backendUrl,
    `/organizations/${orgId}/workspaces/${workspaceId}/webhook`,
  );

  const buildPayload = () => {
    const headersObj: Record<string, string> = {};
    for (const h of headers) {
      if (h.key.trim()) {
        headersObj[h.key.trim()] = h.value;
      }
    }
    return {
      url,
      enabled,
      events,
      headers: Object.keys(headersObj).length > 0 ? headersObj : null,
    };
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    setValidationErrors({});

    try {
      const payload = buildPayload();
      const method = isEditMode ? "PUT" : "POST";

      const response = await fetch(webhookBaseUrl, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        credentials: "include",
      });

      if (response.ok) {
        if (isEditMode) {
          toast.success("Webhook updated");
          onMutate();
        } else {
          toast.success("Webhook created");
          onMutate();
          router.push(
            `/${orgId}/workspace/${workspaceId}/settings/webhook`,
          );
        }
      } else {
        const errorData = await response.json();
        setValidationErrors(parseValidationErrors(errorData));
      }
    } catch (error) {
      console.error("Error saving webhook:", error);
      toast.error("Failed to save webhook");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      const response = await fetch(webhookBaseUrl, {
        method: "DELETE",
        credentials: "include",
      });

      if (response.ok) {
        toast.success("Webhook deleted");
        setIsDeleting(false);
        setIsDeleteDialogOpen(false);
        onMutate();
        router.push(
          `/${orgId}/workspace/${workspaceId}/settings/webhook`,
        );
      } else {
        console.error("Failed to delete webhook");
        toast.error("Failed to delete webhook");
        setIsDeleting(false);
        setIsDeleteDialogOpen(false);
      }
    } catch (error) {
      console.error("Error deleting webhook:", error);
      toast.error("Failed to delete webhook");
      setIsDeleting(false);
      setIsDeleteDialogOpen(false);
    }
  };

  const handleRegenerateSecret = async () => {
    setIsRegenerating(true);
    try {
      const response = await fetch(
        joinUrl(webhookBaseUrl, "/regenerate-secret"),
        {
          method: "POST",
          credentials: "include",
        },
      );

      if (response.ok) {
        toast.success("Signing secret regenerated");
        onMutate();
        setIsRegenerateDialogOpen(false);
      } else {
        toast.error("Failed to regenerate signing secret");
        setIsRegenerateDialogOpen(false);
      }
    } catch (error) {
      console.error("Error regenerating secret:", error);
      toast.error("Failed to regenerate signing secret");
      setIsRegenerateDialogOpen(false);
    } finally {
      setIsRegenerating(false);
    }
  };

  const handleCopySecret = async () => {
    if (webhook?.signingSecret) {
      await navigator.clipboard.writeText(webhook.signingSecret);
      toast.success("Signing secret copied to clipboard");
    }
  };

  const addHeader = () => {
    setHeaders((prev) => [...prev, { key: "", value: "" }]);
  };

  const removeHeader = (index: number) => {
    setHeaders((prev) => prev.filter((_, i) => i !== index));
  };

  const updateHeader = (
    index: number,
    field: "key" | "value",
    value: string,
  ) => {
    setHeaders((prev) =>
      prev.map((h, i) => (i === index ? { ...h, [field]: value } : h)),
    );
  };

  return (
    <div>
      <FieldSet className="mb-6">
        <FieldGroup>
          <Field data-invalid={!!validationErrors.url}>
            <FieldLabel htmlFor="url">URL</FieldLabel>
            <Input
              id="url"
              type="url"
              placeholder="https://example.com/webhook"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                if (validationErrors.url) {
                  setValidationErrors((prev) => {
                    const next = { ...prev };
                    delete next.url;
                    return next;
                  });
                }
              }}
              disabled={isSubmitting}
              aria-invalid={!!validationErrors.url}
              autoFocus
            />
            <FieldDescription>
              The URL that will receive webhook POST requests.
            </FieldDescription>
            {validationErrors.url && (
              <FieldError>{validationErrors.url}</FieldError>
            )}
          </Field>

          <Field>
            <div className="flex items-center gap-3">
              <Switch
                id="enabled"
                checked={enabled}
                onCheckedChange={setEnabled}
                disabled={isSubmitting}
              />
              <FieldLabel htmlFor="enabled" className="mb-0">
                Enabled
              </FieldLabel>
            </div>
            <FieldDescription>
              When disabled, no webhook requests will be sent.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel>Events</FieldLabel>
            <FieldDescription className="mb-3">
              Select which events trigger webhook delivery.
            </FieldDescription>
            <div className="space-y-3">
              {ALL_EVENTS.map((event) => (
                <div key={event} className="flex items-center gap-3">
                  <Switch
                    id={`event-${event}`}
                    checked={events.includes(event)}
                    onCheckedChange={() => toggleEvent(event)}
                    disabled={isSubmitting}
                  />
                  <FieldLabel htmlFor={`event-${event}`} className="mb-0">
                    {EVENT_LABELS[event]}
                  </FieldLabel>
                </div>
              ))}
            </div>
          </Field>

          {isEditMode && webhook && (
            <Field>
              <FieldLabel>Signing Secret</FieldLabel>
              <div className="flex items-center gap-2">
                <Input
                  type={showSecret ? "text" : "password"}
                  value={webhook.signingSecret}
                  readOnly
                  className="font-mono"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="shrink-0 cursor-pointer"
                  onClick={() => setShowSecret(!showSecret)}
                >
                  {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="shrink-0 cursor-pointer"
                  onClick={handleCopySecret}
                >
                  <Copy className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="shrink-0 cursor-pointer"
                  onClick={() => setIsRegenerateDialogOpen(true)}
                  disabled={isSubmitting}
                >
                  <RefreshCw className="h-4 w-4" /> Regenerate
                </Button>
              </div>
              <FieldDescription>
                Used to verify that webhook requests are coming from Platypus.
              </FieldDescription>
            </Field>
          )}

          <Field>
            <FieldLabel>Custom Headers</FieldLabel>
            <FieldDescription className="mb-3">
              Additional headers to include with each webhook request.
            </FieldDescription>
            <div className="space-y-2">
              {headers.map((header, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    placeholder="Header name"
                    value={header.key}
                    onChange={(e) => updateHeader(index, "key", e.target.value)}
                    disabled={isSubmitting}
                    className="flex-1"
                  />
                  <Input
                    placeholder="Header value"
                    value={header.value}
                    onChange={(e) =>
                      updateHeader(index, "value", e.target.value)
                    }
                    disabled={isSubmitting}
                    className="flex-1"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="shrink-0 cursor-pointer"
                    onClick={() => removeHeader(index)}
                    disabled={isSubmitting}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                className="cursor-pointer"
                onClick={addHeader}
                disabled={isSubmitting}
              >
                <Plus className="h-4 w-4" /> Add Header
              </Button>
            </div>
          </Field>
        </FieldGroup>
      </FieldSet>

      <div className="flex gap-2">
        <Button
          className="cursor-pointer"
          onClick={handleSubmit}
          disabled={
            isSubmitting || Object.keys(validationErrors).length > 0
          }
        >
          {isEditMode ? "Update" : "Save"}
        </Button>

        {isEditMode && (
          <Button
            className="cursor-pointer"
            variant="outline"
            onClick={() => setIsDeleteDialogOpen(true)}
            disabled={isSubmitting}
          >
            <Trash2 /> Delete
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
        title="Delete webhook"
        description="Are you sure you want to delete this webhook? This action cannot be undone."
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={handleDelete}
        loading={isDeleting}
      />

      <ConfirmDialog
        open={isRegenerateDialogOpen}
        onOpenChange={setIsRegenerateDialogOpen}
        title="Regenerate signing secret"
        description="Are you sure you want to regenerate the signing secret? The current secret will be invalidated immediately."
        confirmLabel="Regenerate"
        confirmVariant="destructive"
        onConfirm={handleRegenerateSecret}
        loading={isRegenerating}
      />
    </div>
  );
};

export { WebhookForm };
