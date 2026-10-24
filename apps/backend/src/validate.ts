import { sValidator } from "@hono/standard-validator";
import type { ValidationTargets } from "hono";
import { z } from "zod";

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
  sValidator(target, schema, (result, c) =>
    result.success ? undefined : c.json({ error: result.error }, 400),
  );

/**
 * `limit`/`offset` for a list the backend pages. An unreadable or out-of-range
 * value is a 400, never clamped or replaced; only an omitted one takes the
 * default. Extend it with the list's own filters.
 */
export const paginationQuerySchema = (defaultLimit: number) =>
  z.object({
    limit: z.coerce.number().int().min(1).max(100).default(defaultLimit),
    offset: z.coerce.number().int().min(0).default(0),
  });
