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
import { useCallback, useState } from "react";
import { useResetOnChange } from "@/hooks/use-reset-on-change";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import {
  fetcher,
  parseValidationErrors,
  clearFieldError,
  joinUrl,
} from "@/lib/utils";
import { toast } from "sonner";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import { Trash2, Eye, EyeOff, Copy, RefreshCw, Plus, X } from "lucide-react";

interface Webhook {
  id: string;
  workspaceId: string;
  name: string;
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
  webhookId?: string;
}

const ALL_EVENTS = [
  "notification.created",
  "notification.updated",
  "notification.read",
  "notification.dismissed",
  "card.created",
  "card.updated",
  "card.deleted",
] as const;

const EVENT_LABELS: Record<string, string> = {
  "notification.created": "Notification created",
  "notification.updated": "Notification updated",
  "notification.read": "Notification read",
  "notification.dismissed": "Notification dismissed",
  "card.created": "Card created",
  "card.updated": "Card updated",
  "card.deleted": "Card deleted",
};

const WebhookForm = ({ orgId, workspaceId, webhookId }: WebhookFormProps) => {
  const { user } = useAuth();
  const backendUrl = useBackendUrl();
  const router = useRouter();

  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [events, setEvents] = useState<string[]>([...ALL_EVENTS]);
  const [headers, setHeaders] = useState<{ key: string; value: string }[]>([]);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isRegenerateDialogOpen, setIsRegenerateDialogOpen] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [validationErrors, setValidationErrors] = useState<
    Record<string, string>
  >({});

  const isEditMode = !!webhookId;

  const fetchUrl =
    webhookId && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/webhooks/${webhookId}`,
        )
      : null;

  const {
    data: webhook,
    isLoading,
    mutate,
  } = useSWR<Webhook>(fetchUrl, fetcher);

  // Initialise the form from the loaded webhook, once per webhook id.
  useResetOnChange(webhook?.id, () => {
    if (webhook) {
      setName(webhook.name);
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
  });

  // Drop the stored server validation error for the given field(s) so a
  // corrected field stops rendering its error and re-enables the Save button.
  const clearValidationErrors = useCallback((...fieldNames: string[]) => {
    setValidationErrors((prev) =>
      fieldNames.reduce(
        (errors, fieldName) => clearFieldError(errors, fieldName),
        prev,
      ),
    );
  }, []);

  const toggleEvent = (event: string) => {
    clearValidationErrors("events");
    setEvents((prev) => {
      if (prev.includes(event)) {
        if (prev.length === 1) return prev;
        return prev.filter((e) => e !== event);
      }
      return [...prev, event];
    });
  };

  const webhooksBaseUrl = joinUrl(
    backendUrl,
    `/organizations/${orgId}/workspaces/${workspaceId}/webhooks`,
  );

  const buildPayload = () => {
    const headersObj: Record<string, string> = {};
    for (const h of headers) {
      if (h.key.trim()) {
        headersObj[h.key.trim()] = h.value;
      }
    }
    return {
      name,
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
      const requestUrl = isEditMode
        ? joinUrl(webhooksBaseUrl, `/${webhookId}`)
        : webhooksBaseUrl;
      const method = isEditMode ? "PUT" : "POST";

      const response = await fetch(requestUrl, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        credentials: "include",
      });

      if (response.ok) {
        if (isEditMode) {
          toast.success("Webhook updated");
          await mutate();
        } else {
          toast.success("Webhook created");
        }
        router.push(`/${orgId}/workspace/${workspaceId}/settings/webhooks`);
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
      const response = await fetch(joinUrl(webhooksBaseUrl, `/${webhookId}`), {
        method: "DELETE",
        credentials: "include",
      });

      if (response.ok) {
        toast.success("Webhook deleted");
        router.push(`/${orgId}/workspace/${workspaceId}/settings/webhooks`);
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
        joinUrl(webhooksBaseUrl, `/${webhookId}/regenerate-secret`),
        {
          method: "POST",
          credentials: "include",
        },
      );

      if (response.ok) {
        toast.success("Signing secret regenerated");
        await mutate();
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

  const headerRowErrorKey = (key: string) => `headers.${key}`;

  const addHeader = () => {
    clearValidationErrors("headers");
    setHeaders((prev) => [...prev, { key: "", value: "" }]);
  };

  // Retract the whole-field "headers" error (any edit is an attempt to fix
  // it) and the row-level error keyed to this entry, without touching errors
  // stranded on other rows.
  const clearHeaderRowError = (index: number) => {
    const rowKey = headerRowErrorKey(headers[index].key);
    setValidationErrors((prev) => {
      if (!("headers" in prev) && !(rowKey in prev)) return prev;
      const next = { ...prev };
      delete next.headers;
      delete next[rowKey];
      return next;
    });
  };

  const removeHeader = (index: number) => {
    clearHeaderRowError(index);
    setHeaders((prev) => prev.filter((_, i) => i !== index));
  };

  const updateHeader = (
    index: number,
    field: "key" | "value",
    value: string,
  ) => {
    clearHeaderRowError(index);
    setHeaders((prev) =>
      prev.map((h, i) => (i === index ? { ...h, [field]: value } : h)),
    );
  };

  if (isLoading) {
    return <div>Loading...</div>;
  }

  // parseValidationErrors mirrors any headers.<key> issue onto the bare
  // "headers" key too, as a fallback for forms with no per-row UI. This form
  // has one, so once a row is showing that message, repeating it at the
  // field level would just be a duplicate.
  const hasHeaderRowError = headers.some(
    (header) => !!validationErrors[headerRowErrorKey(header.key)],
  );

  return (
    <div>
      <FieldSet className="mb-6">
        <FieldGroup>
          <Field data-invalid={!!validationErrors.name}>
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <Input
              id="name"
              type="text"
              placeholder="My Webhook"
              value={name}
              onChange={(e) => {
                clearValidationErrors("name");
                setName(e.target.value);
              }}
              disabled={isSubmitting}
              aria-invalid={!!validationErrors.name}
              autoFocus
            />
            {validationErrors.name && (
              <FieldError>{validationErrors.name}</FieldError>
            )}
          </Field>

          <Field data-invalid={!!validationErrors.url}>
            <FieldLabel htmlFor="url">URL</FieldLabel>
            <Input
              id="url"
              type="url"
              placeholder="https://example.com/webhook"
              value={url}
              onChange={(e) => {
                clearValidationErrors("url");
                setUrl(e.target.value);
              }}
              disabled={isSubmitting}
              aria-invalid={!!validationErrors.url}
            />
            <FieldDescription>
              The URL that will receive webhook POST requests.
            </FieldDescription>
            {validationErrors.url && (
              <FieldError>{validationErrors.url}</FieldError>
            )}
          </Field>

          <Field data-invalid={!!validationErrors.enabled}>
            <div className="flex items-center gap-3">
              <Switch
                id="enabled"
                checked={enabled}
                onCheckedChange={(checked) => {
                  clearValidationErrors("enabled");
                  setEnabled(checked);
                }}
                disabled={isSubmitting}
              />
              <FieldLabel htmlFor="enabled" className="mb-0">
                Enabled
              </FieldLabel>
            </div>
            <FieldDescription>
              When disabled, no webhook requests will be sent.
            </FieldDescription>
            {validationErrors.enabled && (
              <FieldError>{validationErrors.enabled}</FieldError>
            )}
          </Field>

          <Field data-invalid={!!validationErrors.events}>
            <FieldLabel>Events</FieldLabel>
            <FieldDescription className="mb-3">
              Select which events trigger webhook delivery.
            </FieldDescription>
            <div className="grid grid-cols-2 gap-3">
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
            {validationErrors.events && (
              <FieldError>{validationErrors.events}</FieldError>
            )}
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
                  {showSecret ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
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

          <Field data-invalid={!!validationErrors.headers}>
            <FieldLabel>Custom Headers</FieldLabel>
            <FieldDescription className="mb-3">
              Additional headers to include with each webhook request.
            </FieldDescription>
            <div className="space-y-2">
              {headers.map((header, index) => {
                const rowError =
                  validationErrors[headerRowErrorKey(header.key)];
                return (
                  <div key={index} className="space-y-1">
                    <div className="flex items-center gap-2">
                      <Input
                        placeholder="Header name"
                        value={header.key}
                        onChange={(e) =>
                          updateHeader(index, "key", e.target.value)
                        }
                        disabled={isSubmitting}
                        aria-invalid={!!rowError}
                        className="flex-1"
                      />
                      <Input
                        placeholder="Header value"
                        value={header.value}
                        onChange={(e) =>
                          updateHeader(index, "value", e.target.value)
                        }
                        disabled={isSubmitting}
                        aria-invalid={!!rowError}
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
                    {rowError && <FieldError>{rowError}</FieldError>}
                  </div>
                );
              })}
              <Button
                type="button"
                variant="outline"
                className="cursor-pointer"
                onClick={addHeader}
                disabled={isSubmitting}
              >
                <Plus className="h-4 w-4" /> Add header
              </Button>
            </div>
            {validationErrors.headers && !hasHeaderRowError && (
              <FieldError>{validationErrors.headers}</FieldError>
            )}
          </Field>
        </FieldGroup>
      </FieldSet>

      <div className="flex gap-2">
        <Button
          className="cursor-pointer"
          onClick={handleSubmit}
          disabled={isSubmitting || Object.keys(validationErrors).length > 0}
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
