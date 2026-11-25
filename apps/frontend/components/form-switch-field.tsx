import { type ReactNode } from "react";
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
} from "@/components/ui/field";
import { formFieldIds } from "@/components/form-field-ids";
import { Switch } from "@/components/ui/switch";

export type FormSwitchFieldProps = {
  label: string;
  name: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  error?: string | null;
  description?: ReactNode;
  disabled?: boolean;
  leading?: ReactNode;
  align?: "start" | "end";
  className?: string;
  descriptionClassName?: string;
};

export function FormSwitchField({
  label,
  name,
  checked,
  onCheckedChange,
  error,
  description,
  disabled,
  leading,
  align = "start",
  className,
  descriptionClassName,
}: FormSwitchFieldProps) {
  const ids = formFieldIds(name, { description, error });
  const toggle = (
    <Switch
      id={name}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-invalid={!!error}
      aria-describedby={ids.describedBy}
    />
  );
  return (
    <Field
      orientation="horizontal"
      data-invalid={!!error}
      className={className}
    >
      {align === "start" && toggle}
      <div className="flex flex-1 items-center gap-2">
        {leading}
        <div className="flex flex-col gap-1">
          <FieldLabel htmlFor={name}>{label}</FieldLabel>
          {description && (
            <FieldDescription
              id={ids.descriptionId}
              className={descriptionClassName}
            >
              {description}
            </FieldDescription>
          )}
          {error && <FieldError id={ids.errorId}>{error}</FieldError>}
        </div>
      </div>
      {align === "end" && toggle}
    </Field>
  );
}
