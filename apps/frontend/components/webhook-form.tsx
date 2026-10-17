"use client";

import {
  Field,
  FieldLabel,
  FieldGroup,
  FieldSet,
  FieldLegend,
  FieldDescription,
  FieldError,
  FieldTitle,
} from "@/components/ui/field";
import {
  HEADER_ROW_LABELS,
  KeyValueRowsEditor,
  recordToRows,
  rowsToRecord,
  type KeyValueRow,
} from "@/components/key-value-rows-editor";
import { Input } from "@/components/ui/input";
import {
  eventTriggerEventSchema,
  triggerRunWebhookEventSchema,
} from "@platypus/schemas";
import { FormTextField } from "@/components/form-text-field";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EntityDeleteDialog } from "@/components/entity-delete-dialog";
import { DetailFormState } from "@/components/detail-form-state";
import { FormFooterButtons } from "@/components/form-footer-buttons";
import {
  FieldSkeleton,
  FooterSkeleton,
  FormSkeletonGroup,
  FormSkeletonSet,
} from "@/components/form-skeleton";
import { Skeleton } from "@/components/ui/skeleton";
import { useState } from "react";
import { useEntityDelete, useEntityForm } from "@/hooks/use-entity-form";
import { useRouter } from "next/navigation";
import { joinUrl } from "@/lib/utils";
import { retractExactKeys } from "@/lib/form-errors";
import { writeAt } from "@/lib/api-write";
import { toast } from "sonner";
import { copyWithToast } from "@/lib/clipboard";
import { useBackendUrl } from "@/components/auth-provider";
import { Eye, EyeOff, Copy, RefreshCw } from "lucide-react";
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

/**
 * The picker's groups. Trigger run events are Webhook-only: an Event Trigger
 * cannot subscribe to them, so only this picker offers them.
 */
const EVENT_GROUPS = [
  {
    label: "Notifications",
    events: eventTriggerEventSchema.options.filter((e) =>
      e.startsWith("notification."),
    ),
  },
  {
    label: "Cards",
    events: eventTriggerEventSchema.options.filter((e) =>
      e.startsWith("card."),
    ),
  },
  { label: "Trigger runs", events: triggerRunWebhookEventSchema.options },
];

const ALL_EVENTS = EVENT_GROUPS.flatMap((group) => group.events);

const EVENT_LABELS: Record<string, string> = {
  "notification.created": "Notification created",
  "notification.updated": "Notification updated",
  "notification.read": "Notification read",
  "notification.dismissed": "Notification dismissed",
  "card.created": "Card created",
  "card.updated": "Card updated",
  "card.moved": "Card moved",
  "card.deleted": "Card deleted",
  "trigger_run.succeeded": "Trigger run succeeded",
  "trigger_run.failed": "Trigger run failed",
  "trigger_run.cancelled": "Trigger run cancelled",
  "trigger_run.suppressed": "Trigger run suppressed",
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
  headers: [] as KeyValueRow[],
};

/** A switch beside a single-line label, as the Enabled and event rows are. */
const InlineSwitchSkeleton = () => (
  <div className="flex items-center gap-3">
    <Skeleton className="h-[1.15rem] w-8 shrink-0 rounded-full" />
    <Skeleton className="h-3.5 w-32" />
  </div>
);

const WebhookFormSkeleton = ({ editing }: { editing: boolean }) => (
  <div>
    <FormSkeletonSet>
      <FormSkeletonGroup>
        <FieldSkeleton />
        <FieldSkeleton description={1} />
        <div className="flex flex-col gap-3">
          <InlineSwitchSkeleton />
          <Skeleton className="h-3.5 w-1/2" />
        </div>
        <div className="flex flex-col gap-3">
          <Skeleton className="h-3.5 w-16" />
          <Skeleton className="mb-3 h-3.5 w-1/2" />
          <div className="grid grid-cols-2 gap-3">
            {ALL_EVENTS.map((event) => (
              <InlineSwitchSkeleton key={event} />
            ))}
          </div>
        </div>
        {editing && <FieldSkeleton description={1} />}
        <div className="flex flex-col gap-3">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="mb-3 h-3.5 w-1/2" />
          <Skeleton className="h-9 w-32" />
        </div>
      </FormSkeletonGroup>
    </FormSkeletonSet>
    <FooterSkeleton buttons={editing ? 2 : 1} />
  </div>
);

const WebhookForm = ({ orgId, workspaceId, webhookId }: WebhookFormProps) => {
  const backendUrl = useBackendUrl();
  const router = useRouter();

  const [isRegenerateDialogOpen, setIsRegenerateDialogOpen] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [showSecret, setShowSecret] = useState(false);

  const isEditMode = !!webhookId;

  const {
    record: webhook,
    mutateRecord,
    loadState,
    formData,
    setFormData,
    validationErrors,
    setValidationErrors,
    isSubmitting,
    canSubmit,
    toFieldChange,
    clearErrors,
    submit,
  } = useEntityForm<typeof INITIAL_DATA, unknown, Webhook>({
    initialData: INITIAL_DATA,
    entity: "webhooks",
    scope: { orgId, workspaceId },
    id: webhookId,
    fromRecord: (webhook) => ({
      name: webhook.name,
      url: webhook.url,
      enabled: webhook.enabled,
      events: webhook.events ?? [...ALL_EVENTS],
      headers: recordToRows(webhook.headers),
    }),
    retractableFields: RETRACTABLE_FIELDS,
    buildPayload: (data) => ({
      name: data.name,
      url: data.url,
      enabled: data.enabled,
      events: data.events,
      headers: rowsToRecord(data.headers, null),
    }),
    successMessage: () => (isEditMode ? "Webhook updated" : "Webhook created"),
    onSuccess: () =>
      router.push(workspaceRoutes(orgId, workspaceId).settings.webhooks),
  });

  const {
    isDeleteDialogOpen,
    setIsDeleteDialogOpen,
    isDeleting,
    deleteError,
    openDeleteDialog,
    handleDelete,
  } = useEntityDelete({
    entity: "webhooks",
    scope: { orgId, workspaceId },
    id: webhookId,
    successMessage: "Webhook deleted",
    onSuccess: () =>
      router.push(workspaceRoutes(orgId, workspaceId).settings.webhooks),
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
      await mutateRecord();
    } else {
      toast.error(outcome.message);
    }
    setIsRegenerateDialogOpen(false);
    setIsRegenerating(false);
  };

  const handleCopySecret = async () => {
    if (!webhook?.signingSecret) return;
    await copyWithToast(
      webhook.signingSecret,
      "Signing secret copied to clipboard",
    );
  };

  const headerRowErrorKey = (key: string) => `headers.${key}`;

  // Retract the whole-field "headers" error (any edit is an attempt to fix
  // it) and the row-level error keyed to the edited entry, without touching
  // errors stranded on other rows.
  const changeHeaders = (rows: KeyValueRow[], changed?: KeyValueRow) => {
    if (changed) {
      const keys = ["headers", headerRowErrorKey(changed.key)];
      setValidationErrors((prev) => retractExactKeys(prev, keys));
    } else {
      clearErrors("headers");
    }
    setFormData((prev) => ({ ...prev, headers: rows }));
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

          <Field
            aria-labelledby="webhook-events-label"
            data-invalid={!!validationErrors.events}
          >
            <FieldTitle id="webhook-events-label">Events</FieldTitle>
            <FieldDescription className="mb-3">
              Select which events trigger webhook delivery.
            </FieldDescription>
            <div className="flex flex-col gap-5">
              {EVENT_GROUPS.map((group) => (
                <FieldSet key={group.label} className="gap-0">
                  <FieldLegend variant="label">{group.label}</FieldLegend>
                  <div className="grid grid-cols-2 gap-3">
                    {group.events.map((event) => (
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
                </FieldSet>
              ))}
            </div>
            {validationErrors.events && (
              <FieldError>{validationErrors.events}</FieldError>
            )}
          </Field>

          {isEditMode && webhook && (
            <Field>
              <FieldLabel htmlFor="webhook-signing-secret">
                Signing Secret
              </FieldLabel>
              <div className="flex items-center gap-2">
                <Input
                  id="webhook-signing-secret"
                  type={showSecret ? "text" : "password"}
                  value={webhook.signingSecret}
                  readOnly
                  className="font-mono"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="Show signing secret"
                  aria-pressed={showSecret}
                  className="shrink-0"
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
                  aria-label="Copy signing secret"
                  className="shrink-0"
                  onClick={handleCopySecret}
                >
                  <Copy className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="shrink-0"
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

          <Field
            aria-labelledby="webhook-headers-label"
            data-invalid={!!validationErrors.headers}
          >
            <FieldTitle id="webhook-headers-label">Custom Headers</FieldTitle>
            <FieldDescription className="mb-3">
              Additional headers to include with each webhook request.
            </FieldDescription>
            <KeyValueRowsEditor
              rows={headers}
              onChange={changeHeaders}
              disabled={isSubmitting}
              keyPlaceholder="Header name"
              valuePlaceholder="Header value"
              labels={HEADER_ROW_LABELS}
              addLabel="Add header"
              rowError={(row) => validationErrors[headerRowErrorKey(row.key)]}
            />
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
        error={deleteError}
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
      {...loadState}
      subject="webhook"
      skeleton={<WebhookFormSkeleton editing={isEditMode} />}
      backHref={workspaceRoutes(orgId, workspaceId).settings.webhooks}
      backLabel="Back to webhooks"
    >
      {form}
    </DetailFormState>
  );
};

export { WebhookForm };
