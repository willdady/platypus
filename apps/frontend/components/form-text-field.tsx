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
  revealable?: boolean;
  revealLabel?: string;
};

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
