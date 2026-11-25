import { z } from "zod";
import { logger } from "../logger.ts";

export type BackendJsonSchema = Record<string, unknown>;

const declaresFields = (schema: Record<string, unknown>): boolean => {
  const properties = schema.properties;
  return (
    typeof properties === "object" &&
    properties !== null &&
    Object.keys(properties).length > 0
  );
};

export const backendJsonSchema = (
  backend: string,
  kind: "config" | "credentials",
  schema: z.ZodType,
): BackendJsonSchema | undefined => {
  try {
    const json = z.toJSONSchema(schema, { io: "input" }) as Record<
      string,
      unknown
    >;
    return declaresFields(json) ? json : undefined;
  } catch (cause) {
    // why: one unusable schema must cost its backend a generated form, not the whole catalog
    logger.warn(
      { backend, kind, err: cause },
      "Sandbox backend schema cannot be represented as JSON Schema; its settings form will have no generated fields",
    );
    return undefined;
  }
};
