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
  WEBHOOK_NAME_MAX_LENGTH,
  type Webhook,
} from "@platypus/schemas";
import { FormTextField } from "@/components/form-text-field";
import { FormSwitchField } from "@/components/form-switch-field";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { DetailFormState } from "@/components/detail-form-state";
import { FormFooterButtons } from "@/components/form-footer-buttons";
import {
  FieldSkeleton,
  FooterSkeleton,
  FormSkeletonGroup,
  FormSkeletonSet,
  SwitchRowSkeleton,
  SwitchToggleSkeleton,
} from "@/components/form-skeleton";
import { Skeleton } from "@/components/ui/skeleton";
import { useState } from "react";
import { useEntityDelete, useEntityForm } from "@/hooks/use-entity-form";
import { useMutation } from "@/hooks/use-mutation";
import { useRouter } from "next/navigation";
import { retractExactKeys } from "@/lib/form-errors";
import { scopedUrl, writeAt } from "@/lib/api-write";
import { toast } from "sonner";
import { copyWithToast } from "@/lib/clipboard";
import { useBackendUrl } from "@/components/auth-provider";
import { Eye, EyeOff, Copy, RefreshCw } from "lucide-react";
import { workspaceRoutes } from "@/lib/routes";
import { toggleInList } from "@/lib/toggle-in-list";

type WebhookFormProps = {
  orgId: string;
  workspaceId: string;
  webhookId?: string;
};

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

/** A switch beside a single-line label, as the event rows are. */
function InlineSwitchSkeleton() {
  return (
    <div className="flex items-center gap-3">
      <SwitchToggleSkeleton />
      <Skeleton className="h-3.5 w-32" />
    </div>
  );
}

function WebhookFormSkeleton({ editing }: { editing: boolean }) {
  return (
    <div>
      <FormSkeletonSet>
        <FormSkeletonGroup>
          <FieldSkeleton />
          <FieldSkeleton description={1} />
          {/* The Enabled row: a switch beside its label and description. */}
          <SwitchRowSkeleton />
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
}

function WebhookForm({ orgId, workspaceId, webhookId }: WebhookFormProps) {
  const backendUrl = useBackendUrl();
  const router = useRouter();

  const [isRegenerateDialogOpen, setIsRegenerateDialogOpen] = useState(false);
  const [regenerateError, setRegenerateError] = useState<string | null>(null);
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
    method: "PATCH",
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

  const { dialogProps, openDeleteDialog } = useEntityDelete({
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
      const on = !prev.events.includes(event);
      // The last event stays: a webhook that delivers nothing is not a webhook.
      if (!on && prev.events.length === 1) return prev;
      return { ...prev, events: toggleInList(prev.events, event, on) };
    });
  };

  const { run: handleRegenerateSecret, pending: isRegenerating } = useMutation(
    async () => {
      setRegenerateError(null);
      const outcome = await writeAt(
        scopedUrl(backendUrl, `webhooks/${webhookId}/regenerate-secret`, {
          orgId,
          workspaceId,
        }),
        { method: "POST" },
      );

      if (outcome.outcome === "success") {
        toast.success("Signing secret regenerated");
        await mutateRecord();
        setIsRegenerateDialogOpen(false);
      } else {
        // A refused regenerate stays in the open dialog rather than closing it.
        setRegenerateError(outcome.message);
      }
    },
  );

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
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
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
            maxLength={WEBHOOK_NAME_MAX_LENGTH}
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

          <FormSwitchField
            name="enabled"
            label="Enabled"
            description="When disabled, no webhook requests will be sent."
            checked={formData.enabled}
            onCheckedChange={(checked) => {
              clearErrors("enabled");
              setFormData((prev) => ({ ...prev, enabled: checked }));
            }}
            disabled={isSubmitting}
            error={validationErrors.enabled}
          />

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
                  {showSecret ? <EyeOff /> : <Eye />}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="Copy signing secret"
                  className="shrink-0"
                  onClick={handleCopySecret}
                >
                  <Copy />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="shrink-0"
                  onClick={() => setIsRegenerateDialogOpen(true)}
                  disabled={isSubmitting}
                >
                  <RefreshCw /> Regenerate
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
        type="submit"
        submitText={isEditMode ? "Update" : "Save"}
        pending={isSubmitting}
        submitDisabled={isSubmitting || !canSubmit}
        deleteVisible={isEditMode}
        deleteDisabled={isSubmitting}
        onDelete={openDeleteDialog}
      />

      <DeleteConfirmDialog noun="webhook" {...dialogProps} />

      <ConfirmDialog
        open={isRegenerateDialogOpen}
        onOpenChange={(open) => {
          setIsRegenerateDialogOpen(open);
          if (!open) setRegenerateError(null);
        }}
        title="Regenerate signing secret"
        description="Are you sure you want to regenerate the signing secret? The current secret will be invalidated immediately."
        confirmLabel="Regenerate"
        confirmVariant="destructive"
        onConfirm={handleRegenerateSecret}
        loading={isRegenerating}
        error={regenerateError}
      />
    </form>
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
}

export { WebhookForm };
