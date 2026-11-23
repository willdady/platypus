import { sValidator } from "@hono/standard-validator";
import type { ValidationTargets } from "hono";
import { z } from "zod";

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

export const paginationQuerySchema = (defaultLimit: number) =>
  z.strictObject({
    limit: z.coerce.number().int().min(1).max(100).default(defaultLimit),
    offset: z.coerce.number().int().min(0).default(0),
  });
