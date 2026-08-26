import { nanoid } from "nanoid";
import {
  cronTriggerConfigSchema,
  eventTriggerConfigSchema,
  type CronTriggerConfig,
  type EventTriggerConfig,
  type TriggerType,
} from "@platypus/schemas";
import { db } from "../index.ts";
import { trigger as triggerTable } from "../db/schema.ts";
import type { ScopeContext } from "../scope.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
import { validateCronExpression } from "../utils/cron.ts";
import { requireOwned, updateOwned } from "./workspace-resource.ts";

/**
 * The Trigger write model: the one place `type`/`config` validation and
 * `nextRunAt` computation happen, behind an interface both surfaces call.
 * `routes/trigger.ts` (the UI's HTTP route) and `tools/trigger.ts` (the
 * Agent-facing Tool set) used to each hand-roll this — the Tool's copy
 * imported nothing from `@platypus/schemas`, so it drifted narrower on
 * `filters` and looser on `events` than the real schema allows (#690).
 * Composing the real field-level schemas here (`cronTriggerConfigSchema`,
 * `eventTriggerConfigSchema`) is what actually prevents that drift.
 *
 * Trigger is Workspace-only (the `trigger` table has no `organizationId`
 * column) — no scope union like `services/provider-write.ts`'s. There is no
 * `deleteTrigger`: delete has no domain-specific rule to consolidate, so both
 * callers keep their existing generic delete path.
 *
 * `config` update semantics are full-replace only: supplying `config` on an
 * update replaces it wholesale rather than merging. A caller that wants to
 * preserve part of the existing config reads it first and supplies the
 * complete merged object itself — this is what closes the shallow-merge bug
 * where the Tool's update silently wiped a User-set `columnId`/`changedFields`.
 *
 * Failures are the typed errors of ADR-0010 — `routes/trigger.ts` lets them
 * propagate to the central `onError` mapper; `tools/trigger.ts` catches them
 * and translates to its `{success:false, error}` tool-result shape, since a
 * Tool result isn't an HTTP response.
 */

export type TriggerRow = typeof triggerTable.$inferSelect;

type TriggerBaseFields = {
  agentId: string;
  type: TriggerType;
  name: string;
  description?: string | null;
  instruction: string;
  enabled: boolean;
  maxRunsToKeep: number;
  search: boolean;
  config: CronTriggerConfig | EventTriggerConfig;
};

/**
 * The fields a create carries. Defaults (`enabled`, `maxRunsToKeep`, `search`)
 * are the caller's responsibility to resolve first — the HTTP route gets them
 * from `triggerCreateSchema`'s own Zod defaults, the Tool applies its own
 * (intentionally different) defaults — this module only validates and writes.
 */
export type TriggerCreateFields = TriggerBaseFields;

/** The fields an update carries — only the ones actually supplied. */
export type TriggerUpdateFields = Partial<TriggerBaseFields>;

/**
 * Validates a cron config and returns it normalized (Zod defaults applied —
 * e.g. `timezone` filled in as `"UTC"`) alongside its next run time. Returning
 * the parsed, not the raw, config is what guarantees a concrete `timezone`
 * ends up in the stored row regardless of whether the caller supplied one.
 */
const parseCronConfig = (
  config: unknown,
): { config: CronTriggerConfig; nextRunAt: Date } => {
  const parsed = cronTriggerConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new ValidationError(
      "Cron triggers require a non-empty config.cronExpression and a valid config.timezone.",
    );
  }
  const nextRunAt = validateCronExpression(
    parsed.data.cronExpression,
    parsed.data.timezone,
  );
  if (!nextRunAt) {
    throw new ValidationError(
      "Invalid cron expression or timezone. Example: '0 9 * * *' for daily at 9 AM.",
    );
  }
  return { config: parsed.data, nextRunAt };
};

/**
 * Validates an event config — a non-empty `events` array of real
 * `webhookEventSchema` values, and (if present) `filters` matching the real
 * `eventTriggerFiltersSchema` (`boardId`/`columnId`/`changedFields`) — and
 * returns it normalized, or throws.
 */
const parseEventConfig = (config: unknown): EventTriggerConfig => {
  const parsed = eventTriggerConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new ValidationError(
      "Event triggers require config.events: a non-empty array of valid event names, and, if present, a valid config.filters object.",
    );
  }
  return parsed.data;
};

/**
 * Creates a new Trigger in this Workspace. Branches on `type`: cron
 * expressions are parsed via `validateCronExpression` to compute `nextRunAt`;
 * event configs are validated against the real schema. Throws
 * `ValidationError` on an invalid cron expression/timezone, an invalid or
 * empty `events` array, or invalid `filters`.
 */
export async function createTrigger(
  ctx: ScopeContext,
  fields: TriggerCreateFields,
): Promise<TriggerRow> {
  let nextRunAt: Date | null = null;
  let config: CronTriggerConfig | EventTriggerConfig;
  if (fields.type === "cron") {
    const parsed = parseCronConfig(fields.config);
    config = parsed.config;
    nextRunAt = parsed.nextRunAt;
  } else if (fields.type === "event") {
    config = parseEventConfig(fields.config);
  } else {
    throw new ValidationError(
      "Invalid trigger type. Must be 'cron' or 'event'.",
    );
  }

  const [row] = await db
    .insert(triggerTable)
    .values({
      id: nanoid(),
      workspaceId: ctx.workspaceId,
      agentId: fields.agentId,
      type: fields.type,
      name: fields.name,
      description: fields.description ?? null,
      instruction: fields.instruction,
      enabled: fields.enabled,
      maxRunsToKeep: fields.maxRunsToKeep,
      search: fields.search,
      config,
      nextRunAt,
    })
    .returning();
  return row;
}

/**
 * Updates a Trigger in this Workspace. Throws `NotFoundError` when it does
 * not exist here. `config`, if supplied, replaces the stored value wholesale
 * and is (re)validated against the effective type; `nextRunAt` is recomputed
 * for a cron trigger whose `config`/`type` changed, and cleared for an event
 * trigger.
 */
export async function updateTrigger(
  ctx: ScopeContext,
  triggerId: string,
  fields: TriggerUpdateFields,
): Promise<TriggerRow> {
  const existing = await requireOwned(
    db,
    "trigger",
    triggerId,
    ctx.workspaceId,
  );
  const effectiveType = fields.type ?? (existing.type as TriggerType);

  const updateData: Partial<TriggerRow> = {
    updatedAt: new Date(),
  };
  if (fields.agentId !== undefined) updateData.agentId = fields.agentId;
  if (fields.name !== undefined) updateData.name = fields.name;
  if (fields.description !== undefined)
    updateData.description = fields.description;
  if (fields.instruction !== undefined)
    updateData.instruction = fields.instruction;
  if (fields.enabled !== undefined) updateData.enabled = fields.enabled;
  if (fields.maxRunsToKeep !== undefined)
    updateData.maxRunsToKeep = fields.maxRunsToKeep;
  if (fields.search !== undefined) updateData.search = fields.search;
  if (fields.type !== undefined) updateData.type = fields.type;

  // `config`, when supplied, is set below alongside validation — normalized
  // (Zod defaults applied), not the raw input.
  if (effectiveType === "event") {
    // Event triggers don't have nextRunAt; only (re)validate when config
    // actually changed on this update.
    if (fields.config !== undefined) {
      updateData.config = parseEventConfig(fields.config);
    }
    updateData.nextRunAt = null;
  } else if (effectiveType === "cron") {
    if (fields.config !== undefined || fields.type !== undefined) {
      const effectiveConfigInput = fields.config ?? existing.config;
      const parsed = parseCronConfig(effectiveConfigInput);
      updateData.nextRunAt = parsed.nextRunAt;
      if (fields.config !== undefined) {
        updateData.config = parsed.config;
      }
    }
  } else {
    throw new ValidationError(
      "Invalid trigger type. Must be 'cron' or 'event'.",
    );
  }

  const row = await updateOwned(
    db,
    "trigger",
    triggerId,
    ctx.workspaceId,
    updateData,
  );
  if (!row) {
    throw new NotFoundError("Trigger not found");
  }
  return row;
}
