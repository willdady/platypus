/**
 * The generated half of the Sandbox settings form: turning the JSON Schema a
 * plugin backend registers for its config and credentials into form fields,
 * and turning the typed values back into a request body. The backend is the
 * source of truth — the form renders whatever fields its schema declares,
 * within the widget set below (string, number, boolean, enum and secret
 * string). Anything richer is out of scope and simply not rendered.
 */

/** One property of a backend's JSON Schema, narrowed to what a form reads. */
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

/**
 * A backend's config or credentials schema as the catalog route sends it:
 * JSON Schema, already narrowed to an object whose properties a form fills in.
 */
export type BackendJsonSchema = {
  type?: string;
  properties?: Record<string, BackendSchemaProperty>;
  required?: string[];
  [keyword: string]: unknown;
};

/** Which slice of the Sandbox write a field belongs to. */
export type BackendSchemaSlice = "config" | "credentials";

/** The widgets the generated form supports. */
export type BackendSchemaField = {
  key: string;
  label: string;
  kind: "text" | "number" | "boolean" | "enum";
  /** Rendered masked: every credentials string, plus `format: "password"`. */
  secret: boolean;
  required: boolean;
  description?: string;
  /** An enum's values, in schema order. */
  options?: string[];
  defaultValue?: unknown;
  /** A number field constrained to whole values. */
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

/**
 * The fields a backend's schema declares, in declaration order. A property no
 * widget covers is left out rather than guessed at.
 */
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
      // Credentials are never returned, so every string in them is a secret;
      // a config field opts in with `format: "password"`.
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

/**
 * The request body for one slice of the generated fields. Values arrive as the
 * seed (config as stored) plus what the form holds, and are coerced to the
 * schema's types here so the backend validates real values rather than
 * strings. A field the form never touched is omitted, letting the schema's
 * default or optionality apply; a blank optional field is omitted too, while a
 * blank required one is sent so the backend's own error names it.
 */
export function buildSchemaValues(
  schema: BackendJsonSchema | undefined,
  fields: BackendSchemaField[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const rendered = new Set(fields.map((field) => field.key));

  // A declared property no widget covers (an array, a nested object) cannot be
  // edited here, so its stored value passes through rather than being erased.
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
