import { type ReactNode } from "react";
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";

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
  type?: string;
  trailing?: ReactNode;
  className?: string;
  inputClassName?: string;
  min?: string | number;
  max?: string | number;
  step?: string | number;
  maxLength?: number;
};

// Composes the ui/field + ui/input atoms so the six-line
// Field/FieldLabel/Input/FieldError block doesn't have to be hand-wired at
// every call site. `trailing` renders alongside the error (e.g. a character
// counter) instead of after it, matching skill-form's layout.
export const FormTextField = ({
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
  type = "text",
  trailing,
  className,
  inputClassName,
  min,
  max,
  step,
  maxLength,
}: FormTextFieldProps) => {
  return (
    <Field className={className} data-invalid={!!error}>
      <FieldLabel htmlFor={name}>{label}</FieldLabel>
      <Input
        id={name}
        type={type}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        required={required}
        autoFocus={autoFocus}
        aria-invalid={!!error}
        className={inputClassName}
        min={min}
        max={max}
        step={step}
        maxLength={maxLength}
      />
      {description && <FieldDescription>{description}</FieldDescription>}
      {trailing ? (
        <div className="flex justify-between mt-1">
          {error ? <FieldError>{error}</FieldError> : <div />}
          {trailing}
        </div>
      ) : (
        error && <FieldError>{error}</FieldError>
      )}
    </Field>
  );
};
