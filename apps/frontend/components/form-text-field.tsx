import { type ReactNode } from "react";
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
} from "@/components/ui/field";
import { formFieldIds } from "@/components/form-field-ids";
import { Input } from "@/components/ui/input";
import { RevealableInput } from "@/components/ui/revealable-input";

export type FormTextFieldProps = {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  description?: ReactNode;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  autoFocus?: boolean;
  autoComplete?: string;
  type?: string;
  trailing?: ReactNode;
  className?: string;
  inputClassName?: string;
  min?: string | number;
  max?: string | number;
  step?: string | number;
  maxLength?: number;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  /**
   * Render a secret field with a show/hide control, masked until revealed. The
   * `type` prop does not apply: the control owns it.
   */
  revealable?: boolean;
  /**
   * What the reveal control calls the secret, e.g. "API key". Give each
   * revealable field on a screen its own, so two controls never announce the
   * same name.
   */
  revealLabel?: string;
};

// Composes the ui/field + ui/input atoms so the six-line
// Field/FieldLabel/Input/FieldError block doesn't have to be hand-wired at
// every call site. `trailing` renders alongside the error (e.g. a character
// counter) instead of after it, matching skill-form's layout.
export function FormTextField({
  label,
  name,
  value,
  onChange,
  error,
  description,
  placeholder,
  disabled,
  required,
  autoFocus,
  autoComplete,
  type = "text",
  trailing,
  className,
  inputClassName,
  min,
  max,
  step,
  maxLength,
  onKeyDown,
  revealable,
  revealLabel,
}: FormTextFieldProps) {
  const ids = formFieldIds(name, { description, error });
  // One set of control props, so the revealable and plain inputs cannot drift
  // in what the field wires up. `RevealableInput` owns `type`, overriding
  // whatever the field passes.
  const control = {
    id: name,
    type,
    placeholder,
    value,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      onChange(e.target.value),
    disabled,
    required,
    autoFocus,
    autoComplete,
    "aria-invalid": !!error,
    "aria-describedby": ids.describedBy,
    className: inputClassName,
    min,
    max,
    step,
    maxLength,
    onKeyDown,
  };
  return (
    <Field className={className} data-invalid={!!error}>
      <FieldLabel htmlFor={name}>{label}</FieldLabel>
      {revealable ? (
        <RevealableInput {...control} revealLabel={revealLabel} />
      ) : (
        <Input {...control} />
      )}
      {description && (
        <FieldDescription id={ids.descriptionId}>
          {description}
        </FieldDescription>
      )}
      {trailing ? (
        <div className="flex justify-between mt-1">
          {error ? <FieldError id={ids.errorId}>{error}</FieldError> : <div />}
          {trailing}
        </div>
      ) : (
        error && <FieldError id={ids.errorId}>{error}</FieldError>
      )}
    </Field>
  );
}
