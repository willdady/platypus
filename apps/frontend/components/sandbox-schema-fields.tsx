"use client";

import {
  Field,
  FieldError,
  FieldSet,
  FieldLegend,
} from "@/components/ui/field";
import { SelectGroup, SelectItem, SelectLabel } from "@/components/ui/select";
import { FormSelectField } from "@/components/form-select-field";
import { FormSwitchField } from "@/components/form-switch-field";
import { FormTextField } from "@/components/form-text-field";
import type { FormErrors } from "@/lib/form-errors";
import {
  fieldText,
  fieldsFromSchema,
  type BackendJsonSchema,
  type BackendSchemaField,
  type BackendSchemaSlice,
} from "@/lib/backend-schema-fields";

type SandboxSchemaFieldsProps = {
  /** `config` or `credentials` — the request slice, and the error-key root. */
  slice: BackendSchemaSlice;
  schema: BackendJsonSchema;
  /** Seed values (stored config) plus what the form holds. */
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  errors: FormErrors;
  disabled: boolean;
  /** Credentials are stored and never returned, so blank keeps what is there. */
  hasStoredCredentials?: boolean;
};

const CONTROL_IDS: Record<BackendSchemaSlice, string> = {
  config: "sandbox-config",
  credentials: "sandbox-credentials",
};

/** What a field shows before it is first edited: its value, else its default. */
function displayValue(field: BackendSchemaField, value: unknown): unknown {
  return value === undefined ? field.defaultValue : value;
}

function SchemaField({
  field,
  idPrefix,
  slice,
  values,
  onChange,
  errors,
  disabled,
  hasStoredCredentials,
}: {
  field: BackendSchemaField;
  idPrefix: string;
  slice: BackendSchemaSlice;
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  errors: FormErrors;
  disabled: boolean;
  hasStoredCredentials: boolean;
}) {
  const name = `${idPrefix}-${field.key}`;
  const error = errors[`${slice}.${field.key}`] ?? null;
  const value = displayValue(field, values[field.key]);
  const stored =
    slice === "credentials" && field.secret && hasStoredCredentials;
  const description = [field.description, stored && "Stored."]
    .filter(Boolean)
    .join(" ");
  const storedPlaceholder = stored ? "Stored" : undefined;

  if (field.kind === "boolean") {
    return (
      <FormSwitchField
        label={field.label}
        name={name}
        checked={Boolean(value)}
        onCheckedChange={(checked) => onChange(field.key, checked)}
        error={error}
        description={description || undefined}
        disabled={disabled}
      />
    );
  }

  if (field.kind === "enum") {
    return (
      <FormSelectField
        label={field.label}
        name={name}
        value={fieldText(value)}
        onValueChange={(next) => onChange(field.key, next)}
        disabled={disabled}
        placeholder={`Select ${field.label.toLowerCase()}`}
        description={description || undefined}
        error={error}
      >
        <SelectGroup>
          <SelectLabel>{field.label}</SelectLabel>
          {(field.options ?? []).map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectGroup>
      </FormSelectField>
    );
  }

  return (
    <FormTextField
      label={field.label}
      name={name}
      value={fieldText(value)}
      onChange={(next) => onChange(field.key, next)}
      error={error}
      description={description || undefined}
      disabled={disabled}
      required={field.required}
      placeholder={storedPlaceholder}
      type={
        field.secret ? "password" : field.kind === "number" ? "number" : "text"
      }
      autoComplete={field.secret ? "off" : undefined}
      min={field.min}
      max={field.max}
      step={field.integer ? 1 : undefined}
      inputClassName={field.secret ? "font-mono" : undefined}
    />
  );
}

/**
 * The fields a plugin Sandbox backend declares, rendered from the JSON Schema
 * the catalog carries. Docker and SSH keep their bespoke forms; every other
 * backend gets this one. The supported widgets are string, number, boolean,
 * enum and secret string — a property outside them is not rendered.
 */
function SandboxSchemaFields({
  slice,
  schema,
  values,
  onChange,
  errors,
  disabled,
  hasStoredCredentials = false,
}: SandboxSchemaFieldsProps) {
  const fields = fieldsFromSchema(schema, slice);
  const idPrefix = CONTROL_IDS[slice];
  // An issue rooted at the slice (rather than a field under it) has no input
  // to sit beside; show it above the fields rather than losing it.
  const fieldMessages = new Set(
    fields
      .map((field) => errors[`${slice}.${field.key}`])
      .filter((message): message is string => Boolean(message)),
  );
  const groupError =
    errors[slice] && !fieldMessages.has(errors[slice])
      ? errors[slice]
      : undefined;
  const legend = slice === "config" ? "Configuration" : "Credentials";

  return (
    <FieldSet>
      <FieldLegend>{legend}</FieldLegend>
      {slice === "credentials" && hasStoredCredentials && (
        <p className="text-sm text-muted-foreground">
          Credentials are stored server-side and never shown again. Leave every
          field blank to keep them; filling any field replaces the stored
          credentials.
        </p>
      )}
      {groupError && (
        <Field data-invalid>
          <FieldError>{groupError}</FieldError>
        </Field>
      )}
      {fields.map((field) => (
        <SchemaField
          key={field.key}
          field={field}
          idPrefix={idPrefix}
          slice={slice}
          values={values}
          onChange={onChange}
          errors={errors}
          disabled={disabled}
          hasStoredCredentials={hasStoredCredentials}
        />
      ))}
    </FieldSet>
  );
}

export { SandboxSchemaFields };
