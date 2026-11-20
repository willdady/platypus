"use client";

import { useState } from "react";
import { Settings2, TriangleAlert } from "lucide-react";
import {
  jobSettingsSchema,
  type JobSettings,
  type Provider,
} from "@platypus/schemas";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formFieldIds } from "@/components/form-field-ids";
import {
  hasReasoningControls,
  ReasoningControls,
} from "@/components/reasoning-controls";
import { SamplingControls } from "@/components/sampling-controls";
import { parseValidationErrors, type FormErrors } from "@/lib/form-errors";
import type { ModelConfigView } from "@/lib/model-config";
import { reasoningControlsFor } from "@/lib/resolve-model";

/** Job settings as the controls hold them: unset is `undefined`, never null. */
type JobSettingsDraft = {
  [K in keyof JobSettings]?: NonNullable<JobSettings[K]>;
};

function toDraft(settings: JobSettings | null): JobSettingsDraft {
  return Object.fromEntries(
    Object.entries(settings ?? {}).filter(([, value]) => value != null),
  );
}

/**
 * One of a Provider's own job models (ADR-0045): a Select over the Provider's
 * Model entries, and the Job settings sent with it. An id that is not in the
 * list — saved before the field was a Select — stays selected and is flagged
 * rather than dropped, so a save that touches something else keeps it.
 */
export function JobModelField({
  label,
  name,
  description,
  value,
  settings,
  models,
  provider,
  onChange,
  onSettingsChange,
  error,
  disabled,
  readOnly,
}: {
  label: string;
  name: string;
  description: string;
  value: string;
  settings: JobSettings | null;
  models: ModelConfigView[];
  provider: Pick<Provider, "providerType" | "apiMode">;
  onChange: (value: string) => void;
  onSettingsChange: (settings: JobSettings | null) => void;
  error?: string | null;
  disabled?: boolean;
  /** Settings can still be opened, to read them. */
  readOnly?: boolean;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const entry = models.find((model) => model.id === value);
  const stale = value !== "" && !entry;
  const help = stale
    ? `${value} is not in this provider's model list. It keeps working; add it as a model, or choose another.`
    : description;
  const ids = formFieldIds(name, { description: help, error });

  return (
    <Field data-invalid={!!error}>
      <FieldLabel htmlFor={name}>{label}</FieldLabel>
      <div className="flex gap-2">
        <Select
          value={value}
          onValueChange={onChange}
          disabled={disabled || readOnly}
        >
          <SelectTrigger
            id={name}
            aria-invalid={!!error}
            aria-describedby={ids.describedBy}
            className="min-w-0 flex-1"
          >
            <SelectValue placeholder="Select a model" />
          </SelectTrigger>
          <SelectContent>
            {stale && (
              <SelectItem value={value}>
                {value} (not in the model list)
              </SelectItem>
            )}
            {models.map((model) => (
              <SelectItem key={model.id} value={model.id}>
                {model.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          onClick={() => setSettingsOpen(true)}
          disabled={value === "" || (disabled && !readOnly)}
          aria-label={`${label} settings`}
        >
          <Settings2 />
          Settings
        </Button>
      </div>
      <FieldDescription id={ids.descriptionId}>
        {stale && <TriangleAlert className="mr-1 inline size-3.5" />}
        {help}
      </FieldDescription>
      {error && <FieldError id={ids.errorId}>{error}</FieldError>}
      {settingsOpen && (
        <JobSettingsDialog
          title={`${label} settings`}
          modelId={value}
          map={reasoningControlsFor(provider, entry)}
          settings={settings}
          readOnly={readOnly}
          onSubmit={(next) => {
            onSettingsChange(next);
            setSettingsOpen(false);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </Field>
  );
}

function JobSettingsDialog({
  title,
  modelId,
  map,
  settings,
  readOnly,
  onSubmit,
  onClose,
}: {
  title: string;
  modelId: string;
  map: ReturnType<typeof reasoningControlsFor>;
  settings: JobSettings | null;
  readOnly?: boolean;
  onSubmit: (settings: JobSettings | null) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(() => toDraft(settings));
  const [errors, setErrors] = useState<FormErrors>({});

  const patch = (next: JobSettingsDraft) => {
    setDraft((prev) => ({ ...prev, ...next }));
    setErrors({});
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // React bubbles synthetic events through the portal, so without this the
    // submit would reach the provider form the dialog is rendered in.
    e.stopPropagation();
    const set = toDraft(draft);
    const result = jobSettingsSchema.safeParse(set);
    if (!result.success) {
      setErrors(parseValidationErrors({ error: result.error.issues }));
      return;
    }
    // Nothing set is stored as no block at all, as before Job settings.
    onSubmit(Object.keys(set).length > 0 ? set : null);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            For {modelId}. Nothing is stored until you save the provider.
          </DialogDescription>
        </DialogHeader>
        {/* noValidate: the schema owns every message, as in the Model dialog. */}
        <form
          noValidate
          onSubmit={handleSubmit}
          className="flex flex-col gap-4"
        >
          <p className="text-muted-foreground text-sm">
            Leave a field empty to send nothing and use the model&apos;s own
            default.
          </p>
          {hasReasoningControls(map) && (
            <FieldSet>
              <FieldLegend variant="label">Reasoning</FieldLegend>
              <ReasoningControls
                map={map}
                value={draft}
                onChange={patch}
                disabled={readOnly}
                budgetError={errors.thinkingBudget}
              />
            </FieldSet>
          )}
          <FieldSet>
            <FieldLegend variant="label">Sampling</FieldLegend>
            <SamplingControls
              value={draft}
              onChange={patch}
              errors={errors}
              disabled={readOnly}
            />
          </FieldSet>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {readOnly ? "Close" : "Cancel"}
            </Button>
            {!readOnly && <Button type="submit">Save</Button>}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
