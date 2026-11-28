import { sValidator } from "@hono/standard-validator";
import type { ValidationTargets } from "hono";

type StandardSchema = Parameters<typeof sValidator>[1];

export const validate = <
  Target extends keyof ValidationTargets,
  Schema extends StandardSchema,
>(
  target: Target,
  schema: Schema,
) =>
  sValidator(target, schema, (result, c) =>
    result.success ? undefined : c.json({ error: result.error }, 400),
  );
