import {
  REASONING_EFFORT_STEPS,
  type ReasoningEffort,
  type ReasoningMap,
} from "@platypus/schemas";
import { FieldGroup } from "@/components/ui/field";
import { FormTextField } from "@/components/form-text-field";
import { FormSelectField } from "@/components/form-select-field";
import { SelectItem } from "@/components/ui/select";

// why: Radix Select refuses an empty string, so unset is its own value
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

export function hasReasoningControls(map: ReasoningMap | undefined): boolean {
  return !!(map?.thinking ?? map?.effort ?? map?.budget);
}

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
  // why: a step this model lacks is never sent, but the stored value is kept
  const effort =
    value.reasoningEffort && map.effort?.[value.reasoningEffort]
      ? value.reasoningEffort
      : MODEL_DEFAULT;

  return (
    <FieldGroup className="grid grid-cols-2">
      {map.thinking && (
        <FormSelectField
          label="Thinking"
          name="reasoningThinking"
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
          <SelectItem value={MODEL_DEFAULT}>Model default</SelectItem>
          <SelectItem value="on">On</SelectItem>
          <SelectItem value="off">Off</SelectItem>
        </FormSelectField>
      )}
      {steps.length > 0 && (
        <FormSelectField
          label="Effort"
          name="reasoningEffort"
          value={effort}
          onValueChange={(v) =>
            onChange({
              reasoningEffort:
                v === MODEL_DEFAULT ? undefined : (v as ReasoningEffort),
            })
          }
          disabled={disabled || thinkingOff}
        >
          <SelectItem value={MODEL_DEFAULT}>Model default</SelectItem>
          {steps.map((step) => (
            <SelectItem key={step} value={step}>
              {EFFORT_LABELS[step]}
            </SelectItem>
          ))}
        </FormSelectField>
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
