import { describe, it, expect } from "vitest";
import {
  buildSchemaValues,
  fieldsFromSchema,
  type BackendJsonSchema,
} from "./backend-schema-fields";

const schema: BackendJsonSchema = {
  type: "object",
  properties: {
    region: { type: "string", description: "Where to run" },
    replicas: {
      type: "integer",
      default: 1,
      minimum: 1,
      maximum: 5,
    },
    warm: { type: "boolean" },
    tier: { type: "string", enum: ["standard", "fast"], title: "Tier" },
    token: { type: "string", format: "password" },
    tags: { type: "array", items: { type: "string" } },
  },
  required: ["region", "tier"],
};

describe("fieldsFromSchema", () => {
  it("maps supported properties to fields, in declaration order", () => {
    const fields = fieldsFromSchema(schema, "config");

    expect(fields.map((f) => f.key)).toEqual([
      "region",
      "replicas",
      "warm",
      "tier",
      "token",
    ]);
    expect(fields[0]).toMatchObject({
      key: "region",
      label: "Region",
      kind: "text",
      required: true,
      secret: false,
      description: "Where to run",
    });
    expect(fields[1]).toMatchObject({
      key: "replicas",
      label: "Replicas",
      kind: "number",
      required: false,
      integer: true,
      defaultValue: 1,
      min: 1,
      max: 5,
    });
    expect(fields[2]).toMatchObject({ kind: "boolean", required: false });
    expect(fields[3]).toMatchObject({
      kind: "enum",
      label: "Tier",
      options: ["standard", "fast"],
      required: true,
    });
  });

  it("renders credentials strings as secret fields", () => {
    const [field] = fieldsFromSchema(
      { properties: { apiToken: { type: "string" } }, required: ["apiToken"] },
      "credentials",
    );

    expect(field).toMatchObject({ key: "apiToken", secret: true });
  });

  it("honours a password format on a config field", () => {
    const [field] = fieldsFromSchema(
      { properties: { secret: { type: "string", format: "password" } } },
      "config",
    );

    expect(field.secret).toBe(true);
  });

  it("leaves out a property no widget covers", () => {
    const fields = fieldsFromSchema(
      {
        properties: {
          tags: { type: "array", items: { type: "string" } },
          nested: { type: "object" },
          odd: { anyOf: [{ type: "string" }] },
        },
      },
      "config",
    );

    expect(fields).toEqual([]);
  });

  it("returns no fields for a schema that declares none", () => {
    expect(
      fieldsFromSchema({ type: "object", properties: {} }, "config"),
    ).toEqual([]);
    expect(fieldsFromSchema(undefined, "config")).toEqual([]);
  });
});

describe("buildSchemaValues", () => {
  const fields = fieldsFromSchema(schema, "config");

  it("sends a number as a number and a boolean as a boolean", () => {
    const values = buildSchemaValues(schema, fields, {
      region: "eu",
      replicas: "3",
      warm: true,
      tier: "fast",
    });

    expect(values).toEqual({
      region: "eu",
      replicas: 3,
      warm: true,
      tier: "fast",
    });
  });

  it("keeps a required text field's empty value so the schema rejects it", () => {
    expect(
      buildSchemaValues(schema, fields, { region: "", tier: "standard" }),
    ).toEqual({
      region: "",
      tier: "standard",
    });
  });

  it("omits an optional field left blank, and an unparseable number", () => {
    const optionalSchema = {
      properties: {
        region: { type: "string" },
        replicas: { type: "number" },
        warm: { type: "boolean" },
      },
    };
    const optional = fieldsFromSchema(optionalSchema, "config");

    expect(
      buildSchemaValues(optionalSchema, optional, {
        region: "  ",
        replicas: "",
        warm: undefined,
      }),
    ).toEqual({});
    expect(
      buildSchemaValues(optionalSchema, optional, { replicas: "abc" }),
    ).toEqual({});
  });

  it("passes through a declared property no widget covers", () => {
    expect(
      buildSchemaValues(schema, fields, {
        region: "eu",
        tier: "fast",
        tags: ["alpha"],
      }),
    ).toEqual({ region: "eu", tier: "fast", tags: ["alpha"] });
  });

  it("sends only the fields the schema declares", () => {
    expect(
      buildSchemaValues(schema, fields, {
        region: "eu",
        tier: "fast",
        stale: "x",
      }),
    ).toEqual({ region: "eu", tier: "fast" });
  });
});
