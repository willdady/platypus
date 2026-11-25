export type BackendSchemaProperty = {
  type?: string;
  title?: string;
  description?: string;
  format?: string;
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  [keyword: string]: unknown;
};

export type BackendJsonSchema = {
  type?: string;
  properties?: Record<string, BackendSchemaProperty>;
  required?: string[];
  [keyword: string]: unknown;
};

export type BackendSchemaSlice = "config" | "credentials";

export type BackendSchemaField = {
  key: string;
  label: string;
  kind: "text" | "number" | "boolean" | "enum";
  secret: boolean;
  required: boolean;
  description?: string;
  options?: string[];
  defaultValue?: unknown;
  integer?: boolean;
  min?: number;
  max?: number;
};

function humanize(key: string): string {
  const words = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function fieldText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function widgetFor(
  property: BackendSchemaProperty,
): BackendSchemaField["kind"] | null {
  if (Array.isArray(property.enum)) {
    return property.enum.every((value) => typeof value === "string")
      ? "enum"
      : null;
  }
  if (property.type === "boolean") return "boolean";
  if (property.type === "integer" || property.type === "number")
    return "number";
  if (property.type === "string") return "text";
  return null;
}

export function fieldsFromSchema(
  schema: BackendJsonSchema | undefined,
  slice: BackendSchemaSlice,
): BackendSchemaField[] {
  const required = new Set(schema?.required ?? []);
  const fields: BackendSchemaField[] = [];

  for (const [key, property] of Object.entries(schema?.properties ?? {})) {
    const kind = widgetFor(property);
    if (!kind) continue;
    fields.push({
      key,
      label: property.title ?? humanize(key),
      kind,
      // why: credentials are never returned, so every string in them is a secret
      secret:
        kind === "text" &&
        (slice === "credentials" || property.format === "password"),
      required: required.has(key),
      ...(property.description && { description: property.description }),
      ...(kind === "enum" && { options: property.enum as string[] }),
      ...(property.default !== undefined && {
        defaultValue: property.default,
      }),
      ...(kind === "number" && {
        integer: property.type === "integer",
        ...(property.minimum !== undefined && { min: property.minimum }),
        ...(property.maximum !== undefined && { max: property.maximum }),
      }),
    });
  }

  return fields;
}

function isBlank(value: string): boolean {
  return value.trim() === "";
}

export function buildSchemaValues(
  schema: BackendJsonSchema | undefined,
  fields: BackendSchemaField[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const rendered = new Set(fields.map((field) => field.key));

  for (const key of Object.keys(schema?.properties ?? {})) {
    if (!rendered.has(key) && values[key] !== undefined) {
      body[key] = values[key];
    }
  }

  for (const field of fields) {
    const value = values[field.key];
    if (value === undefined || value === null) continue;

    if (field.kind === "boolean") {
      body[field.key] = Boolean(value);
      continue;
    }

    const text = fieldText(value);
    if (field.kind === "number") {
      if (isBlank(text)) continue;
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) continue;
      body[field.key] = parsed;
      continue;
    }

    if (field.kind === "text" && isBlank(text) && !field.required) continue;
    if (field.kind === "enum" && isBlank(text)) continue;
    body[field.key] = text;
  }

  return body;
}
