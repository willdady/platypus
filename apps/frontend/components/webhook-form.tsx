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
import { FormTextField } from "@/components/form-text-field";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EntityDeleteDialog } from "@/components/entity-delete-dialog";
import { DetailFormState } from "@/components/detail-form-state";
import { FormFooterButtons } from "@/components/form-footer-buttons";
import { useCallback, useState } from "react";
import { useResetOnChange } from "@/hooks/use-reset-on-change";
import { useEntityDelete, useEntityForm } from "@/hooks/use-entity-form";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { fetcher, joinUrl } from "@/lib/utils";
import { retractExactKeys } from "@/lib/form-errors";
import { writeAt } from "@/lib/api-write";
import { toast } from "sonner";
import { useAuth, useBackendUrl } from "@/components/auth-provider";
import { Eye, EyeOff, Copy, RefreshCw, Plus, X } from "lucide-react";
import { workspaceRoutes } from "@/lib/routes";

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
  "card.moved",
  "card.deleted",
] as const;

const EVENT_LABELS: Record<string, string> = {
  "notification.created": "Notification created",
  "notification.updated": "Notification updated",
  "notification.read": "Notification read",
  "notification.dismissed": "Notification dismissed",
  "card.created": "Card created",
  "card.updated": "Card updated",
  "card.moved": "Card moved",
  "card.deleted": "Card deleted",
};

const RETRACTABLE_FIELDS = [
  "name",
  "url",
  "enabled",
  "events",
  "headers",
] as const;

const INITIAL_DATA = {
  name: "",
  url: "",
  enabled: true,
  events: [...ALL_EVENTS] as string[],
  headers: [] as { key: string; value: string }[],
};

const WebhookForm = ({ orgId, workspaceId, webhookId }: WebhookFormProps) => {
  const { user } = useAuth();
  const backendUrl = useBackendUrl();
  const router = useRouter();

  const [isRegenerateDialogOpen, setIsRegenerateDialogOpen] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [showSecret, setShowSecret] = useState(false);

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
    error: webhookError,
    isLoading,
    mutate,
  } = useSWR<Webhook>(fetchUrl, fetcher);

  const {
    formData,
    setFormData,
    validationErrors,
    setValidationErrors,
    isSubmitting,
    canSubmit,
    toFieldChange,
    clearErrors,
    submit,
  } = useEntityForm<typeof INITIAL_DATA, unknown>({
    initialData: INITIAL_DATA,
    entity: "webhooks",
    scope: { orgId, workspaceId },
    id: webhookId,
    retractableFields: RETRACTABLE_FIELDS,
    buildPayload: (data) => {
      const headersObj: Record<string, string> = {};
      for (const h of data.headers) {
        if (h.key.trim()) {
          headersObj[h.key.trim()] = h.value;
        }
      }
      return {
        name: data.name,
        url: data.url,
        enabled: data.enabled,
        events: data.events,
        headers: Object.keys(headersObj).length > 0 ? headersObj : null,
      };
    },
    successMessage: () => (isEditMode ? "Webhook updated" : "Webhook created"),
    onSuccess: () =>
      router.push(workspaceRoutes(orgId, workspaceId).settings.webhooks),
  });

  const {
    isDeleteDialogOpen,
    setIsDeleteDialogOpen,
    isDeleting,
    openDeleteDialog,
    handleDelete,
  } = useEntityDelete({
    entity: "webhooks",
    scope: { orgId, workspaceId },
    id: webhookId,
    successMessage: "Webhook deleted",
    onSuccess: () =>
      router.push(workspaceRoutes(orgId, workspaceId).settings.webhooks),
    onError: (message, _outcome, { close }) => {
      toast.error(message);
      close();
    },
  });

  // Initialise the form from the loaded webhook, once per webhook id.
  useResetOnChange(webhook?.id, () => {
    if (webhook) {
      setFormData({
        name: webhook.name,
        url: webhook.url,
        enabled: webhook.enabled,
        events: webhook.events ?? [...ALL_EVENTS],
        headers: webhook.headers
          ? Object.entries(webhook.headers).map(([key, value]) => ({
              key,
              value,
            }))
          : [],
      });
    }
  });

  const { events, headers } = formData;

  const toggleEvent = (event: string) => {
    clearErrors("events");
    setFormData((prev) => {
      if (prev.events.includes(event)) {
        if (prev.events.length === 1) return prev;
        return { ...prev, events: prev.events.filter((e) => e !== event) };
      }
      return { ...prev, events: [...prev.events, event] };
    });
  };

  const webhooksBaseUrl = joinUrl(
    backendUrl,
    `/organizations/${orgId}/workspaces/${workspaceId}/webhooks`,
  );

  const handleRegenerateSecret = async () => {
    setIsRegenerating(true);
    const outcome = await writeAt(
      joinUrl(webhooksBaseUrl, `/${webhookId}/regenerate-secret`),
      { method: "POST" },
    );

    if (outcome.outcome === "success") {
      toast.success("Signing secret regenerated");
      await mutate();
    } else {
      toast.error(outcome.message);
    }
    setIsRegenerateDialogOpen(false);
    setIsRegenerating(false);
  };

  const handleCopySecret = async () => {
    if (webhook?.signingSecret) {
      await navigator.clipboard.writeText(webhook.signingSecret);
      toast.success("Signing secret copied to clipboard");
    }
  };

  const headerRowErrorKey = (key: string) => `headers.${key}`;

  const addHeader = () => {
    clearErrors("headers");
    setFormData((prev) => ({
      ...prev,
      headers: [...prev.headers, { key: "", value: "" }],
    }));
  };

  // Retract the whole-field "headers" error (any edit is an attempt to fix
  // it) and the row-level error keyed to this entry, without touching errors
  // stranded on other rows.
  const clearHeaderRowError = useCallback(
    (index: number) => {
      const rowKey = headerRowErrorKey(headers[index].key);
      setValidationErrors((prev) =>
        retractExactKeys(prev, ["headers", rowKey]),
      );
    },
    [headers, setValidationErrors],
  );

  const removeHeader = (index: number) => {
    clearHeaderRowError(index);
    setFormData((prev) => ({
      ...prev,
      headers: prev.headers.filter((_, i) => i !== index),
    }));
  };

  const updateHeader = (
    index: number,
    field: "key" | "value",
    value: string,
  ) => {
    clearHeaderRowError(index);
    setFormData((prev) => ({
      ...prev,
      headers: prev.headers.map((h, i) =>
        i === index ? { ...h, [field]: value } : h,
      ),
    }));
  };

  // parseValidationErrors mirrors any headers.<key> issue onto the bare
  // "headers" key too, as a fallback for forms with no per-row UI. This form
  // has one, so once a row is showing that message, repeating it at the
  // field level would just be a duplicate.
  const hasHeaderRowError = headers.some(
    (header) => !!validationErrors[headerRowErrorKey(header.key)],
  );

  const form = (
    <div>
      <FieldSet className="mb-6">
        <FieldGroup>
          <FormTextField
            label="Name"
            name="name"
            placeholder="My Webhook"
            value={formData.name}
            onChange={toFieldChange("name")}
            disabled={isSubmitting}
            error={validationErrors.name}
            autoFocus
          />

          <FormTextField
            label="URL"
            name="url"
            type="url"
            placeholder="https://example.com/webhook"
            value={formData.url}
            onChange={toFieldChange("url")}
            disabled={isSubmitting}
            error={validationErrors.url}
            description="The URL that will receive webhook POST requests."
          />

          <Field data-invalid={!!validationErrors.enabled}>
            <div className="flex items-center gap-3">
              <Switch
                id="enabled"
                checked={formData.enabled}
                onCheckedChange={(checked) => {
                  clearErrors("enabled");
                  setFormData((prev) => ({ ...prev, enabled: checked }));
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

      <FormFooterButtons
        submitText={isEditMode ? "Update" : "Save"}
        onSubmit={() => void submit()}
        submitDisabled={isSubmitting || !canSubmit}
        deleteVisible={isEditMode}
        deleteDisabled={isSubmitting}
        onDelete={openDeleteDialog}
      />

      <EntityDeleteDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
        title="Delete webhook"
        description="Are you sure you want to delete this webhook? This action cannot be undone."
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

  return (
    <DetailFormState
      isLoading={isLoading}
      error={webhookError}
      data={webhook}
      subject="webhook"
      backHref={workspaceRoutes(orgId, workspaceId).settings.webhooks}
      backLabel="Back to webhooks"
    >
      {form}
    </DetailFormState>
  );
};

export { WebhookForm };
