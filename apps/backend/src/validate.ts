import { sValidator } from "@hono/standard-validator";
import type { ValidationTargets } from "hono";

type StandardSchema = Parameters<typeof sValidator>[1];

/**
 * Request validation for every route. A failure answers 400 with the issues
 * array alone under `error` — the shape the frontend maps onto form fields —
 * instead of `sValidator`'s default, which adds `success` and echoes the
 * submitted body back as `data`.
 */
export const validate = <
  Target extends keyof ValidationTargets,
  Schema extends StandardSchema,
>(
  target: Target,
  schema: Schema,
) =>
  sValidator(target, schema, (result, c) => {
    if (!result.success) return c.json({ error: result.error }, 400);
  });
