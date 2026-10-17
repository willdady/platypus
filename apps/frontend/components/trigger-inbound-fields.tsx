"use client";

import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { FormSelectField } from "@/components/form-select-field";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SelectItem } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  InboundTokenDialog,
  inboundEndpointUrl,
} from "@/components/inbound-token-dialog";
import { useBackendUrl } from "@/components/auth-provider";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, RefreshCw, X } from "lucide-react";
import {
  BEARER_TOKEN_EXPIRY_DAYS,
  DEFAULT_BEARER_TOKEN_EXPIRY_DAYS,
  INBOUND_TRIGGER_INPUT_DESCRIPTION_MAX_LENGTH,
  INBOUND_TRIGGER_INPUT_NAME_MAX_LENGTH,
  INBOUND_TRIGGER_MAX_INPUTS,
  inboundTriggerInputNameRegex,
} from "@platypus/schemas";
import { toast } from "sonner";
import { formatDateTime } from "@/lib/format-date";
import { workspaceRoutes } from "@/lib/routes";
import { scopedUrl, writeAt } from "@/lib/api-write";
import { joinUrl } from "@/lib/utils";
import { TOKEN_STATUS_LABELS, TOKEN_STATUS_VARIANTS } from "@/lib/bearer-token";
import type {
  SavedTrigger,
  TriggerFieldsProps,
} from "@/components/trigger-form";

/** One declared input as the form edits it; saved as `inputs[]` (ADR-0030). */
type InboundInputDraft = {
  name: string;
  required: boolean;
  description: string;
};

/**
 * What stops the declared inputs from saving, if anything. The backend checks
 * the same rules; this only moves the message next to the rows.
 */
function inboundInputsProblem(inputs: InboundInputDraft[]): string | null {
  const names = inputs.map((input) => input.name.trim());
  if (names.some((name) => name === "")) return "Every input needs a name.";
  const bad = names.find((name) => !inboundTriggerInputNameRegex.test(name));
  if (bad !== undefined) {
    return `"${bad}" is not a valid input name. Start with a letter or underscore, then use only letters, digits and underscores.`;
  }
  const duplicate = names.find((name, i) => names.indexOf(name) !== i);
  if (duplicate !== undefined) {
    return `"${duplicate}" is declared more than once.`;
  }
  return null;
}

/** A token being shown in the one-time dialog, and where to go after. */
type ShownToken = {
  token: string;
  triggerId: string;
  expiresAt?: string | null;
  leaveOnClose: boolean;
};

/**
 * An Inbound Trigger's declared inputs, record key and token lifetime, and,
 * once saved, its token: status, regenerate, and the one-time token dialog.
 */
function TriggerInboundFields({
  active,
  trigger,
  scope,
  disabled,
  errors,
  clearErrors,
  onChange,
  mutateRecord,
}: TriggerFieldsProps) {
  const saved = trigger?.type === "inbound" ? trigger.config : undefined;
  const backendUrl = useBackendUrl();
  const router = useRouter();

  const [inboundInputs, setInboundInputs] = useState<InboundInputDraft[]>(
    () =>
      saved?.inputs.map((input) => ({
        name: input.name,
        required: input.required,
        description: input.description ?? "",
      })) ?? [],
  );
  const [recordKey, setRecordKey] = useState<string>(saved?.recordKey ?? "");
  const [tokenExpiryDays, setTokenExpiryDays] = useState<number>(
    saved?.tokenExpiryDays ?? DEFAULT_BEARER_TOKEN_EXPIRY_DAYS,
  );
  const [shownToken, setShownToken] = useState<ShownToken | null>(null);
  const [isRegenerateDialogOpen, setIsRegenerateDialogOpen] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);

  const requiredInputNames = inboundInputs
    .filter((input) => input.required && input.name.trim())
    .map((input) => input.name.trim());
  // The record key names an input, so renaming, removing or un-requiring that
  // input unmarks it rather than saving a key that names nothing.
  const effectiveRecordKey = requiredInputNames.includes(recordKey)
    ? recordKey
    : "";

  const inputsProblem = inboundInputsProblem(inboundInputs);
  const inboundConfigErrors = Object.entries(errors)
    .filter(([key]) => key === "config" || key.startsWith("config."))
    .map(([, message]) => message);

  const tokenStatus = trigger?.tokenStatus ?? "none";
  const hasToken = tokenStatus !== "none";

  // A new Inbound Trigger's token is in the save's response and never again,
  // so it is shown before leaving the page.
  const handleSaved = useCallback((result: SavedTrigger) => {
    if (!result?.token) return false;
    setShownToken({
      token: result.token,
      triggerId: result.id,
      expiresAt: result.tokenExpiresAt,
      leaveOnClose: true,
    });
    return true;
  }, []);

  useEffect(() => {
    onChange({
      type: "inbound",
      config: {
        inputs: inboundInputs.map((input) => ({
          name: input.name.trim(),
          required: input.required,
          ...(input.description.trim()
            ? { description: input.description.trim() }
            : {}),
        })),
        ...(effectiveRecordKey ? { recordKey: effectiveRecordKey } : {}),
        tokenExpiryDays,
      },
      valid: inputsProblem === null,
      onSaved: handleSaved,
    });
  }, [
    onChange,
    inboundInputs,
    effectiveRecordKey,
    tokenExpiryDays,
    inputsProblem,
    handleSaved,
  ]);

  const updateInboundInputs = (
    update: (prev: InboundInputDraft[]) => InboundInputDraft[],
  ) => {
    clearErrors("config");
    setInboundInputs(update);
  };

  const updateInboundInput = (
    index: number,
    patch: Partial<InboundInputDraft>,
  ) =>
    updateInboundInputs((prev) =>
      prev.map((input, i) => (i === index ? { ...input, ...patch } : input)),
    );

  const handleRegenerateToken = async () => {
    if (!backendUrl || !trigger) return;
    setIsRegenerating(true);
    const outcome = await writeAt<{ token: string; tokenExpiresAt: string }>(
      joinUrl(scopedUrl(backendUrl, "triggers", scope), `/${trigger.id}/token`),
      { method: "POST" },
    );
    if (outcome.outcome === "success") {
      setShownToken({
        token: outcome.data.token,
        triggerId: trigger.id,
        expiresAt: outcome.data.tokenExpiresAt,
        leaveOnClose: false,
      });
      await mutateRecord();
    } else {
      toast.error(outcome.message);
    }
    setIsRegenerateDialogOpen(false);
    setIsRegenerating(false);
  };

  const closeTokenDialog = () => {
    const leave = shownToken?.leaveOnClose;
    setShownToken(null);
    if (leave) {
      router.push(workspaceRoutes(scope.orgId, scope.workspaceId).root);
    }
  };

  return (
    <>
      {/* The dialogs outlive the fields, so a gate that closes while a new
          token is on screen can't take the token with it. */}
      {active && (
        <>
          <Field
            aria-labelledby="trigger-inputs-label"
            data-invalid={inboundConfigErrors.length > 0}
          >
            <FieldTitle id="trigger-inputs-label">Inputs</FieldTitle>
            <FieldDescription>
              The values a caller sends as{" "}
              <code>{`{ "inputs": { ... } }`}</code>. Every value is a string. A
              call with a missing required input, an undeclared one, or a value
              that isn&apos;t a string is refused.
            </FieldDescription>
            <div className="flex flex-col gap-3 mt-2">
              {inboundInputs.map((input, index) => (
                <div
                  key={index}
                  className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-start"
                >
                  <Input
                    aria-label={`Input ${index + 1} name`}
                    placeholder="issueKey"
                    className="font-mono sm:w-44"
                    value={input.name}
                    maxLength={INBOUND_TRIGGER_INPUT_NAME_MAX_LENGTH}
                    onChange={(e) =>
                      updateInboundInput(index, {
                        name: e.target.value,
                      })
                    }
                    disabled={disabled}
                  />
                  <Input
                    aria-label={`Input ${index + 1} description`}
                    placeholder="What the agent should know about it"
                    className="flex-1"
                    value={input.description}
                    maxLength={INBOUND_TRIGGER_INPUT_DESCRIPTION_MAX_LENGTH}
                    onChange={(e) =>
                      updateInboundInput(index, {
                        description: e.target.value,
                      })
                    }
                    disabled={disabled}
                  />
                  <div className="flex items-center justify-between gap-3 sm:h-9">
                    <Field orientation="horizontal" className="w-auto">
                      <Switch
                        id={`input-${index}-required`}
                        checked={input.required}
                        onCheckedChange={(checked) =>
                          updateInboundInput(index, {
                            required: checked,
                          })
                        }
                        disabled={disabled}
                      />
                      <FieldLabel htmlFor={`input-${index}-required`}>
                        Required
                      </FieldLabel>
                    </Field>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="shrink-0"
                      aria-label={`Remove input ${index + 1}`}
                      onClick={() =>
                        updateInboundInputs((prev) =>
                          prev.filter((_, i) => i !== index),
                        )
                      }
                      disabled={disabled}
                    >
                      <X />
                    </Button>
                  </div>
                </div>
              ))}
              <div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    updateInboundInputs((prev) => [
                      ...prev,
                      { name: "", required: true, description: "" },
                    ])
                  }
                  disabled={
                    disabled ||
                    inboundInputs.length >= INBOUND_TRIGGER_MAX_INPUTS
                  }
                >
                  <Plus /> Add input
                </Button>
              </div>
            </div>
            {inputsProblem && <FieldError>{inputsProblem}</FieldError>}
            {inboundConfigErrors.map((message) => (
              <FieldError key={message}>{message}</FieldError>
            ))}
          </Field>

          <FormSelectField
            label="Record key"
            name="recordKey"
            value={effectiveRecordKey || "__none__"}
            onValueChange={(value) =>
              setRecordKey(value === "__none__" ? "" : value)
            }
            disabled={disabled}
            description="The required input that says which record a call is about, such as an issue key. Only one run per record is active at a time, and the run-rate limit counts each record separately. With none, the limit counts the whole trigger. Marking one is the expected setup."
          >
            <SelectItem value="__none__">None</SelectItem>
            {requiredInputNames.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </FormSelectField>

          <FormSelectField
            label="Token lifetime"
            name="tokenExpiryDays"
            value={String(tokenExpiryDays)}
            onValueChange={(value) => setTokenExpiryDays(Number(value))}
            disabled={disabled}
            description={
              trigger
                ? "Applies to the next token you issue. The current token keeps its expiry date."
                : "How long the token works. You get a notification 30 and 7 days before it expires."
            }
          >
            {BEARER_TOKEN_EXPIRY_DAYS.map((days) => (
              <SelectItem key={days} value={String(days)}>
                {days} days
              </SelectItem>
            ))}
          </FormSelectField>

          {trigger && (
            <Field>
              <FieldTitle>Token</FieldTitle>
              <div className="flex flex-col gap-2 rounded-md border p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <Badge variant={TOKEN_STATUS_VARIANTS[tokenStatus]}>
                    {TOKEN_STATUS_LABELS[tokenStatus]}
                  </Badge>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setIsRegenerateDialogOpen(true)}
                    disabled={disabled}
                  >
                    <RefreshCw /> {hasToken ? "Regenerate" : "Issue token"}
                  </Button>
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-muted-foreground">
                  <dt>Issued</dt>
                  <dd>
                    {trigger.tokenCreatedAt
                      ? formatDateTime(trigger.tokenCreatedAt)
                      : "—"}
                  </dd>
                  <dt>Expires</dt>
                  <dd>
                    {trigger.tokenExpiresAt
                      ? formatDateTime(trigger.tokenExpiresAt)
                      : "—"}
                  </dd>
                  <dt>Last used</dt>
                  <dd>
                    {trigger.lastUsedAt
                      ? formatDateTime(trigger.lastUsedAt)
                      : "Never"}
                  </dd>
                  <dt>Last rejected</dt>
                  <dd>
                    {trigger.lastRejectedAt
                      ? formatDateTime(trigger.lastRejectedAt)
                      : "Never"}
                  </dd>
                </dl>
                {backendUrl && (
                  <p className="break-all text-muted-foreground">
                    Endpoint:{" "}
                    <code>{inboundEndpointUrl(backendUrl, trigger.id)}</code>
                  </p>
                )}
              </div>
              <FieldDescription>
                {hasToken
                  ? "The token was shown once, when it was issued. Regenerating stops the current one working straight away."
                  : "This trigger has no token, so every call is refused. An Org Admin may have revoked it. Issue a new one and update the system that calls it."}
              </FieldDescription>
            </Field>
          )}
        </>
      )}

      <ConfirmDialog
        open={isRegenerateDialogOpen}
        onOpenChange={setIsRegenerateDialogOpen}
        title={hasToken ? "Regenerate token" : "Issue token"}
        description={
          hasToken
            ? "The current token stops working straight away. Update the system that calls this trigger with the new one."
            : "A new token is issued and shown once."
        }
        confirmLabel={hasToken ? "Regenerate" : "Issue token"}
        onConfirm={() => void handleRegenerateToken()}
        loading={isRegenerating}
      />

      {shownToken && (
        <InboundTokenDialog
          token={shownToken.token}
          endpointUrl={inboundEndpointUrl(
            backendUrl ?? "",
            shownToken.triggerId,
          )}
          inputNames={inboundInputs
            .map((input) => input.name.trim())
            .filter(Boolean)}
          expiresAt={shownToken.expiresAt}
          onClose={closeTokenDialog}
        />
      )}
    </>
  );
}

export { TriggerInboundFields };
