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
  /** The `SelectItem`s to render inside the content. */
  children: ReactNode;
  error?: string | null;
  description?: ReactNode;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
  /**
   * Accessible name for the trigger, e.g. "Action for <Workspace name>".
   * The visible label still renders above the trigger; pass nothing to keep
   * the label as the accessible name.
   */
  ariaLabel?: string;
};

// Composes the ui/field + ui/select atoms so the
// Field/FieldLabel/Select/SelectTrigger/SelectValue/FieldError block doesn't
// have to be hand-wired at every call site, matching `FormTextField`.
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
