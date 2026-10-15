import { type ReactNode } from "react";
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
} from "@/components/ui/field";
import { formFieldIds } from "@/components/form-field-ids";
import { Textarea } from "@/components/ui/textarea";

export type FormTextareaFieldProps = {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  description?: ReactNode;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  rows?: number;
  maxLength?: number;
  className?: string;
  textareaClassName?: string;
};

// Composes the ui/field + ui/textarea atoms so the
// Field/FieldLabel/Textarea/FieldError block doesn't have to be hand-wired at
// every call site, matching `FormTextField`.
export const FormTextareaField = ({
  label,
  name,
  value,
  onChange,
  error,
  description,
  placeholder,
  disabled,
  required,
  rows,
  maxLength,
  className,
  textareaClassName,
}: FormTextareaFieldProps) => {
  const ids = formFieldIds(name, { description, error });
  return (
    <Field className={className} data-invalid={!!error}>
      <FieldLabel htmlFor={name}>{label}</FieldLabel>
      <Textarea
        id={name}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        required={required}
        rows={rows}
        maxLength={maxLength}
        aria-invalid={!!error}
        aria-describedby={ids.describedBy}
        className={textareaClassName}
      />
      {description && (
        <FieldDescription id={ids.descriptionId}>
          {description}
        </FieldDescription>
      )}
      {error && <FieldError id={ids.errorId}>{error}</FieldError>}
    </Field>
  );
};
