import { type ReactNode } from "react";
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
} from "@/components/ui/field";
import { formFieldIds } from "@/components/form-field-ids";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type FormSelectFieldProps = {
  label: string;
  name: string;
  value: string;
  onValueChange: (value: string) => void;
  children: ReactNode;
  error?: string | null;
  description?: ReactNode;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
  ariaLabel?: string;
};

export function FormSelectField({
  label,
  name,
  value,
  onValueChange,
  children,
  error,
  description,
  placeholder,
  disabled,
  className,
  triggerClassName,
  ariaLabel,
}: FormSelectFieldProps) {
  const ids = formFieldIds(name, { description, error });
  return (
    <Field className={className} data-invalid={!!error}>
      <FieldLabel htmlFor={name}>{label}</FieldLabel>
      <Select value={value} onValueChange={onValueChange} disabled={disabled}>
        <SelectTrigger
          id={name}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-invalid={!!error}
          aria-describedby={ids.describedBy}
          className={triggerClassName}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>{children}</SelectContent>
      </Select>
      {description && (
        <FieldDescription id={ids.descriptionId}>
          {description}
        </FieldDescription>
      )}
      {error && <FieldError id={ids.errorId}>{error}</FieldError>}
    </Field>
  );
}
