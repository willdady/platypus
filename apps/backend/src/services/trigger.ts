import { nanoid } from "nanoid";
import { desc } from "drizzle-orm";
import {
  cronTriggerConfigSchema,
  eventTriggerConfigSchema,
  triggerTypeSchema,
  type CronTriggerConfig,
  type EventTriggerConfig,
  type TriggerType,
} from "@platypus/schemas";
import { db } from "../index.ts";
import { trigger as triggerTable } from "../db/schema.ts";
import type { ScopeContext } from "../scope.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
import { validateCronExpression } from "../utils/cron.ts";
import { resolveScoped } from "./scoped-resource.ts";
import {
  deleteOwned,
  listOwned,
  requireOwned,
  updateOwned,
} from "./workspace-resource.ts";

/**
 * The Trigger model: the one place `type`/`config` validation, the Agent
 * visibility check, create defaults and `nextRunAt` computation happen, and
 * the reads both surfaces share, behind an interface both surfaces call.
 * `routes/trigger.ts` (the UI's HTTP route) and `tools/trigger.ts` (the
 * Agent-facing Tool set) used to each hand-roll this — the Tool's copy
 * imported nothing from `@platypus/schemas`, so it drifted narrower on
 * `filters` and looser on `events` than the real schema allows (#690).
 * Composing the real field-level schemas here (`cronTriggerConfigSchema`,
 * `eventTriggerConfigSchema`) is what actually prevents that drift.
 *
 * Trigger is Workspace-only (the `trigger` table has no `organizationId`
 * column) — no scope union like `services/provider-write.ts`'s. Its reads and
 * delete are thin over `workspace-resource.ts`, so neither caller hand-rolls
 * the Workspace containment predicate.
 *
 * A Trigger's Agent must be usable in the Workspace — Workspace-scoped, or a
 * Shared one attached here (ADR-0007), the same set a run resolves when the
 * Trigger fires — so create and update check it here, not at each caller.
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
  enabled?: boolean;
  maxRunsToKeep?: number;
  search?: boolean;
  includeMemories?: boolean;
  config: CronTriggerConfig | EventTriggerConfig;
};

/**
 * The fields a create carries. `enabled`, `maxRunsToKeep`, `search` and
 * `includeMemories` are optional: an omitted one takes {@link CREATE_DEFAULTS}.
 * The HTTP route always supplies them, already defaulted by
 * `triggerCreateSchema`'s Zod defaults.
 */
export type TriggerCreateFields = TriggerBaseFields;

/**
 * What a create stores for a field the caller omitted — matching the `trigger`
 * table's column defaults and the Trigger form.
 */
const CREATE_DEFAULTS = {
  enabled: true,
  // `triggerCreateSchema` defaults this to 50, so an HTTP caller omitting it
  // gets 50, not 10.
  maxRunsToKeep: 10,
  search: false,
  includeMemories: false,
};

/** The fields an update carries — only the ones actually supplied. */
export type TriggerUpdateFields = Partial<TriggerBaseFields>;

/**
 * A Trigger row's `type` and `config`, narrowed together. The table stores
 * `type` as plain text and `config` as jsonb, so the pair is only a
 * discriminated union once something has checked it.
 */
export type TypedTriggerConfig =
  | { type: "cron"; config: CronTriggerConfig }
  | { type: "event"; config: EventTriggerConfig };

/**
 * Narrows a stored row's `type` + `config` into {@link TypedTriggerConfig},
 * validated against the real config schemas. A malformed row throws here — the
 * one place it can — rather than surfacing as an `undefined` read wherever a
 * caller cast the jsonb to the shape it hoped for.
 */
export const narrowTriggerConfig = (
  row: Pick<TriggerRow, "id" | "type" | "config">,
): TypedTriggerConfig => {
  if (row.type === "cron") {
    const parsed = cronTriggerConfigSchema.safeParse(row.config);
    if (parsed.success) return { type: "cron", config: parsed.data };
  } else if (row.type === "event") {
    const parsed = eventTriggerConfigSchema.safeParse(row.config);
    if (parsed.success) return { type: "event", config: parsed.data };
  }
  throw new Error(
    `Trigger '${row.id}' has a malformed '${row.type}' type/config pair`,
  );
};

/**
 * The next `nextRunAt` a cron config names, from now — or `null` when the
 * expression or timezone cannot be parsed. The one statement of the schedule
 * rule: the write model, the post-run bookkeeping and the recovery sweep all
 * call it.
 */
export const nextCronRunAt = (config: CronTriggerConfig): Date | null =>
  validateCronExpression(config.cronExpression, config.timezone);

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
  const nextRunAt = nextCronRunAt(parsed.data);
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

/** Throws `ValidationError` unless the Agent is usable in this Workspace. */
const requireUsableAgent = async (
  ctx: ScopeContext,
  agentId: string,
): Promise<void> => {
  if (!(await resolveScoped(db, "agent", agentId, ctx))) {
    throw new ValidationError("Agent not found in this workspace");
  }
};

/**
 * Creates a new Trigger in this Workspace. Branches on `type`: cron
 * expressions are parsed via `nextCronRunAt` to compute `nextRunAt`;
 * event configs are validated against the real schema. Throws
 * `ValidationError` on an Agent not usable here, an invalid cron
 * expression/timezone, an invalid or empty `events` array, or invalid
 * `filters`.
 */
export async function createTrigger(
  ctx: ScopeContext,
  fields: TriggerCreateFields,
): Promise<TriggerRow> {
  await requireUsableAgent(ctx, fields.agentId);

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
      enabled: fields.enabled ?? CREATE_DEFAULTS.enabled,
      maxRunsToKeep: fields.maxRunsToKeep ?? CREATE_DEFAULTS.maxRunsToKeep,
      search: fields.search ?? CREATE_DEFAULTS.search,
      includeMemories:
        fields.includeMemories ?? CREATE_DEFAULTS.includeMemories,
      config,
      nextRunAt,
    })
    .returning();
  return row;
}

/**
 * Updates a Trigger in this Workspace. Throws `NotFoundError` when it does
 * not exist here — checked before a supplied `agentId`, which throws
 * `ValidationError` when not usable here. `config`, if supplied, replaces the
 * stored value wholesale and is (re)validated against the effective type;
 * `nextRunAt` is recomputed for a cron trigger whose `config`/`type` changed
 * or which is being enabled, and cleared for an event trigger.
 */
export async function updateTrigger(
  ctx: ScopeContext,
  triggerId: string,
  fields: TriggerUpdateFields,
): Promise<TriggerRow> {
  const existing = await requireOwned(db, "trigger", {
    id: triggerId,
    workspaceId: ctx.workspaceId,
  });
  if (fields.agentId !== undefined) {
    await requireUsableAgent(ctx, fields.agentId);
  }
  // Only the stored type is read here, not its config: an update that supplies
  // a new config must be able to repair a row whose stored one is malformed.
  // An unknown stored type falls through to the `ValidationError` below.
  const effectiveType: TriggerType | undefined =
    fields.type ?? triggerTypeSchema.safeParse(existing.type).data;

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
  if (fields.includeMemories !== undefined)
    updateData.includeMemories = fields.includeMemories;
  if (fields.type !== undefined) updateData.type = fields.type;

  // `config`, when supplied, is set below alongside validation — normalized
  // (Zod defaults applied), not the raw input.
  if (effectiveType === "event") {
    // Event triggers don't have nextRunAt. Revalidate when the config changed
    // *or* when the type did: a change of type re-reads the stored config under
    // the other shape's schema, so flipping a cron Trigger to `event` without
    // supplying a config fails loud here rather than storing a cron config under
    // `type: "event"` — a Trigger that looks configured and can never fire. The
    // cron branch below guards the mirror case; this is the same guard.
    if (fields.config !== undefined || fields.type !== undefined) {
      const parsed = parseEventConfig(fields.config ?? existing.config);
      if (fields.config !== undefined) {
        updateData.config = parsed;
      }
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
    } else if (fields.enabled === true && !existing.enabled) {
      // Re-enabling restarts the schedule. Disabling leaves `nextRunAt` at
      // whatever it was, so by the time a Trigger is switched back on that
      // value is in the past — and the scheduler's due query is
      // `nextRunAt <= NOW()`, which reads a stale timestamp as "due" and fires
      // an off-schedule catch-up run on the very next tick. The run after that
      // one is scheduled from *its* completion time, so the catch-up and the
      // first real slot can land a minute apart before the cadence settles.
      // Recomputing here means an enabled Trigger's first run is always a slot
      // its own expression actually names.
      updateData.nextRunAt = parseCronConfig(existing.config).nextRunAt;
    }
  } else {
    throw new ValidationError(
      "Invalid trigger type. Must be 'cron' or 'event'.",
    );
  }

  const row = await updateOwned(
    db,
    "trigger",
    { id: triggerId, workspaceId: ctx.workspaceId },
    updateData,
  );
  if (!row) {
    throw new NotFoundError("Trigger not found");
  }
  return row;
}

/**
 * This Workspace's Triggers, newest first — only the enabled ones when
 * `enabledOnly` is set.
 */
export async function listTriggers(
  ctx: ScopeContext,
  { enabledOnly = false }: { enabledOnly?: boolean } = {},
): Promise<TriggerRow[]> {
  const rows = await listOwned(
    db,
    "trigger",
    { workspaceId: ctx.workspaceId },
    desc(triggerTable.createdAt),
  );
  return enabledOnly ? rows.filter((row) => row.enabled) : rows;
}

/** A Trigger in this Workspace. Throws `NotFoundError` when not here. */
export const getTrigger = (
  ctx: ScopeContext,
  triggerId: string,
): Promise<TriggerRow> =>
  requireOwned(db, "trigger", { id: triggerId, workspaceId: ctx.workspaceId });

/** Deletes a Trigger in this Workspace; `false` when none was here. */
export const deleteTrigger = (
  ctx: ScopeContext,
  triggerId: string,
): Promise<boolean> =>
  deleteOwned(db, "trigger", { id: triggerId, workspaceId: ctx.workspaceId });
