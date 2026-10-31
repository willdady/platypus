import {
  REASONING_EFFORT_STEPS,
  type ReasoningEffort,
  type ReasoningMap,
} from "@platypus/schemas";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { FormTextField } from "@/components/form-text-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** An unset control, as a Select value (Radix refuses an empty string). */
const MODEL_DEFAULT = "default";

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export type ReasoningValue = {
  reasoningThinking?: boolean;
  reasoningEffort?: ReasoningEffort;
  thinkingBudget?: number;
};

/** Whether the map declares any control a User can set. */
export function hasReasoningControls(map: ReasoningMap | undefined): boolean {
  return !!(map?.thinking ?? map?.effort ?? map?.budget);
}

/**
 * The Reasoning controls (ADR-0040) for the selected model: each one shown only
 * where the model's Reasoning map declares it, Effort offering only the steps
 * it declares. Unset means the model's default. Shared by the Agent form and
 * the Chat settings dialog so the two offer the same choices.
 */
export function ReasoningControls({
  map,
  value,
  onChange,
  disabled,
  budgetError,
}: {
  map: ReasoningMap | undefined;
  value: ReasoningValue;
  onChange: (patch: ReasoningValue) => void;
  disabled?: boolean;
  budgetError?: string | null;
}) {
  if (!map || !hasReasoningControls(map)) return null;

  const steps = REASONING_EFFORT_STEPS.filter((step) => map.effort?.[step]);
  const thinkingOff =
    !!map.thinking &&
    (value.reasoningThinking ?? map.default?.thinking) === false;
  // A stored step this model lacks is never sent, so it shows as the default;
  // the stored value itself is left alone for a switch back.
  const effort =
    value.reasoningEffort && map.effort?.[value.reasoningEffort]
      ? value.reasoningEffort
      : MODEL_DEFAULT;

  return (
    <FieldGroup className="grid grid-cols-2">
      {map.thinking && (
        <Field>
          <FieldLabel htmlFor="reasoningThinking">Thinking</FieldLabel>
          <Select
            value={
              value.reasoningThinking === undefined
                ? MODEL_DEFAULT
                : value.reasoningThinking
                  ? "on"
                  : "off"
            }
            onValueChange={(v) =>
              onChange({
                reasoningThinking: v === MODEL_DEFAULT ? undefined : v === "on",
              })
            }
            disabled={disabled}
          >
            <SelectTrigger id="reasoningThinking" disabled={disabled}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={MODEL_DEFAULT}>Model default</SelectItem>
              <SelectItem value="on">On</SelectItem>
              <SelectItem value="off">Off</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      )}
      {steps.length > 0 && (
        <Field>
          <FieldLabel htmlFor="reasoningEffort">Effort</FieldLabel>
          <Select
            value={effort}
            onValueChange={(v) =>
              onChange({
                reasoningEffort:
                  v === MODEL_DEFAULT ? undefined : (v as ReasoningEffort),
              })
            }
            disabled={disabled || thinkingOff}
          >
            <SelectTrigger
              id="reasoningEffort"
              disabled={disabled || thinkingOff}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={MODEL_DEFAULT}>Model default</SelectItem>
              {steps.map((step) => (
                <SelectItem key={step} value={step}>
                  {EFFORT_LABELS[step]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
      {map.budget && (
        <FormTextField
          label="Thinking budget"
          name="thinkingBudget"
          type="number"
          min={1}
          step="1"
          placeholder="Model default"
          value={String(value.thinkingBudget ?? "")}
          onChange={(v) =>
            onChange({ thinkingBudget: v === "" ? undefined : Number(v) })
          }
          disabled={disabled || thinkingOff}
          error={budgetError}
        />
      )}
    </FieldGroup>
  );
}
