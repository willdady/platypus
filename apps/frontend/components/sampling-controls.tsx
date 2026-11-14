import {
  PENALTY_MAX,
  PENALTY_MIN,
  TEMPERATURE_MIN,
  TOP_K_MIN,
  TOP_P_MAX,
  TOP_P_MIN,
  type Chat,
  type ChatSamplingField,
} from "@platypus/schemas";
import { FieldGroup } from "@/components/ui/field";
import { FormTextField } from "@/components/form-text-field";
import { cn } from "@/lib/utils";

/** The six sampling parameters, taken from the schema both screens are judged by. */
type SamplingValue = Partial<Pick<Chat, ChatSamplingField>>;

/** A validation message per field, from whichever screen owns validation. */
type SamplingErrors = Partial<Record<ChatSamplingField, string | null>>;

/**
 * The six sampling fields, in the order both screens have always shown them.
 * Bounds come from the schema the request is judged by, so the browser's hints
 * cannot drift from it; `step` is only there for the continuous values.
 */
const FIELDS: ReadonlyArray<{
  field: ChatSamplingField;
  label: string;
  parse: (value: string) => number;
  min?: number;
  max?: number;
  step?: string;
}> = [
  {
    field: "temperature",
    label: "Temperature",
    parse: parseFloat,
    min: TEMPERATURE_MIN,
    step: "0.1",
  },
  { field: "seed", label: "Seed", parse: (value) => parseInt(value, 10) },
  {
    field: "topP",
    label: "Top-p",
    parse: parseFloat,
    min: TOP_P_MIN,
    max: TOP_P_MAX,
    step: "0.1",
  },
  {
    field: "topK",
    label: "Top-k",
    parse: (value) => parseInt(value, 10),
    min: TOP_K_MIN,
  },
  {
    field: "presencePenalty",
    label: "Presence Penalty",
    parse: parseFloat,
    min: PENALTY_MIN,
    max: PENALTY_MAX,
    step: "0.1",
  },
  {
    field: "frequencyPenalty",
    label: "Frequency Penalty",
    parse: parseFloat,
    min: PENALTY_MIN,
    max: PENALTY_MAX,
    step: "0.1",
  },
];

/**
 * The sampling controls shared by the Agent form and the Chat settings dialog,
 * so the two offer the same six fields with the same labels, order and bounds.
 * A cleared field reports `undefined`, meaning the Provider or model default.
 */
export function SamplingControls({
  value,
  onChange,
  errors,
  disabled,
  className,
}: {
  value: SamplingValue;
  onChange: (patch: SamplingValue) => void;
  errors?: SamplingErrors;
  disabled?: boolean;
  /** Spacing overrides, so each screen keeps the grid gap it had before. */
  className?: string;
}) {
  return (
    <FieldGroup className={cn("grid grid-cols-2", className)}>
      {FIELDS.map(({ field, label, parse, min, max, step }) => (
        <FormTextField
          key={field}
          label={label}
          name={field}
          type="number"
          min={min}
          max={max}
          step={step}
          value={String(value[field] ?? "")}
          onChange={(v) =>
            onChange({ [field]: v === "" ? undefined : parse(v) })
          }
          disabled={disabled}
          error={errors?.[field]}
        />
      ))}
    </FieldGroup>
  );
}
