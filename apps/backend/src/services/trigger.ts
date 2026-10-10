import { nanoid } from "nanoid";
import { asc, desc, eq, inArray } from "drizzle-orm";
import {
  cronTriggerConfigSchema,
  eventTriggerConfigSchema,
  inboundTriggerConfigSchema,
  triggerTypeSchema,
  type CronTriggerConfig,
  type EventTriggerConfig,
  type InboundTriggerConfig,
  type TriggerRunStatus,
  type TriggerType,
} from "@platypus/schemas";
import { db, type Tx } from "../index.ts";
import {
  trigger as triggerTable,
  triggerRun as triggerRunTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import type { ScopeContext } from "../scope.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
import { validateCronExpression } from "../utils/cron.ts";
import {
  generateBearerToken,
  bearerTokenStatus,
  issuedTokenFields,
} from "./bearer-token.ts";
import { resolveScoped } from "./scoped-resource.ts";
import {
  deleteOwned,
  listOwned,
  requireOwned,
  resolveOwned,
  updateOwned,
} from "./workspace-resource.ts";

/** Makes a leaked Inbound Trigger token recognisable; see `generateBearerToken`. */
const INBOUND_TOKEN_PREFIX = "pit_";

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
  config: CronTriggerConfig | EventTriggerConfig | InboundTriggerConfig;
};

/**
 * Who is writing. Only the Workspace Owner, through the UI, may create, edit
 * or delete an Inbound Trigger (ADR-0030): the Agent's Trigger tools must
 * never mint a live credential into a model's context or a Chat transcript,
 * nor stop an integration a caller depends on. Defaults to the narrower
 * surface, so a new caller has to opt in to reaching Inbound Triggers.
 */
export type TriggerWriteOptions = { allowInbound?: boolean };

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
  maxRunsToKeep: 10,
  search: false,
  includeMemories: false,
};

/**
 * The fields an update carries — only the ones actually supplied. `config` is
 * unparsed: its shape depends on the Trigger's effective type, which only the
 * stored row can settle when the update names none, so `updateTrigger`
 * validates it against that type.
 */
export type TriggerUpdateFields = Partial<Omit<TriggerBaseFields, "config">> & {
  config?: unknown;
};

/**
 * A Trigger row's `type` and `config`, narrowed together. The table stores
 * `type` as plain text and `config` as jsonb, so the pair is only a
 * discriminated union once something has checked it.
 */
export type TypedTriggerConfig =
  | { type: "cron"; config: CronTriggerConfig }
  | { type: "event"; config: EventTriggerConfig }
  | { type: "inbound"; config: InboundTriggerConfig };

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
  } else if (row.type === "inbound") {
    const parsed = inboundTriggerConfigSchema.safeParse(row.config);
    if (parsed.success) return { type: "inbound", config: parsed.data };
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
 * `eventTriggerEventSchema` values, and (if present) `filters` matching the real
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
 * Validates an inbound config — at most ten uniquely named string inputs, and
 * a record key, if any, naming a required one — and returns it normalized, or
 * throws with the first problem, since a form has one field to point at.
 */
const parseInboundConfig = (config: unknown): InboundTriggerConfig => {
  const parsed = inboundTriggerConfigSchema.safeParse(config);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ValidationError(
      `Invalid inbound trigger config: ${issue?.message ?? "malformed"}`,
    );
  }
  return parsed.data;
};

/** At most this many One-off Triggers that have yet to fire, per Workspace. */
export const MAX_PENDING_ONE_OFF_TRIGGERS = 50;

/** How long a fired One-off Trigger outlives the end of its run. */
export const FIRED_ONE_OFF_TTL_DAYS = 7;

const isOneOffConfig = (config: unknown): boolean =>
  cronTriggerConfigSchema.safeParse(config).data?.isOneOff === true;

/** A One-off Trigger that has not fired yet, enabled or not. */
const isPendingOneOff = (
  row: Pick<TriggerRow, "type" | "config" | "firedAt">,
): boolean => row.type === "cron" && !row.firedAt && isOneOffConfig(row.config);

/**
 * Throws `ValidationError` when this Workspace already holds its limit of
 * pending One-off Triggers. Holds the Workspace row until `tx` commits, so
 * concurrent writes count one after the other and cannot land over the limit.
 */
const requireOneOffRoom = async (tx: Tx, ctx: ScopeContext): Promise<void> => {
  await tx
    .select({ id: workspaceTable.id })
    .from(workspaceTable)
    .where(eq(workspaceTable.id, ctx.workspaceId))
    .for("update");
  const rows = await listOwned(
    tx,
    "trigger",
    { workspaceId: ctx.workspaceId },
    null,
  );
  if (rows.filter(isPendingOneOff).length >= MAX_PENDING_ONE_OFF_TRIGGERS) {
    throw new ValidationError(
      `This workspace already has ${MAX_PENDING_ONE_OFF_TRIGGERS} one-off triggers that have not yet fired, the most it can hold. Delete one, or wait for one to fire.`,
    );
  }
};

/**
 * Throws `ValidationError` when an update would re-arm a fired One-off
 * Trigger: re-enable it, change its type, or change its schedule. Anything
 * else, such as a rename, is allowed.
 */
const requireNotReArmed = (
  existing: TriggerRow,
  fields: TriggerUpdateFields,
): void => {
  const stored = cronTriggerConfigSchema.safeParse(existing.config).data;
  const next =
    fields.config === undefined
      ? stored
      : cronTriggerConfigSchema.safeParse(fields.config).data;
  const sameSchedule =
    !!stored &&
    !!next &&
    next.cronExpression === stored.cronExpression &&
    next.timezone === stored.timezone &&
    next.isOneOff === stored.isOneOff;
  if (
    fields.enabled === true ||
    (fields.type !== undefined && fields.type !== existing.type) ||
    !sameSchedule
  ) {
    throw new ValidationError(
      "This one-off trigger has already fired and cannot be re-enabled or rescheduled. Create a new trigger instead.",
    );
  }
};

const INBOUND_ONLY_IN_UI =
  "Inbound triggers can only be created, edited and deleted by the Workspace Owner in the Triggers page.";

/**
 * A Trigger row as either surface returns it: without the token's hash or the
 * notice bookkeeping, and with how its token stands. The one
 * projection both surfaces use, so a hash cannot reach a response or a Tool
 * result by a caller forgetting to strip it.
 */
export const toPublicTrigger = (row: TriggerRow) => {
  const { tokenHash: _tokenHash, tokenNotice: _tokenNotice, ...rest } = row;
  return {
    ...rest,
    tokenStatus: bearerTokenStatus(row),
  };
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
  { allowInbound = false }: TriggerWriteOptions = {},
): Promise<TriggerRow & { issuedToken?: string }> {
  if (fields.type === "inbound" && !allowInbound) {
    throw new ValidationError(INBOUND_ONLY_IN_UI);
  }
  await requireUsableAgent(ctx, fields.agentId);

  let nextRunAt: Date | null = null;
  let config: CronTriggerConfig | EventTriggerConfig | InboundTriggerConfig;
  let tokenFields: ReturnType<typeof issuedTokenFields> | undefined;
  let token: string | undefined;
  let oneOff = false;
  if (fields.type === "cron") {
    const parsed = parseCronConfig(fields.config);
    config = parsed.config;
    nextRunAt = parsed.nextRunAt;
    oneOff = parsed.config.isOneOff === true;
  } else if (fields.type === "event") {
    config = parseEventConfig(fields.config);
  } else if (fields.type === "inbound") {
    const inbound = parseInboundConfig(fields.config);
    config = inbound;
    const generated = generateBearerToken(INBOUND_TOKEN_PREFIX);
    token = generated.token;
    tokenFields = issuedTokenFields(generated.hash, inbound.tokenExpiryDays);
  } else {
    throw new ValidationError(
      "Invalid trigger type. Must be 'cron', 'event' or 'inbound'.",
    );
  }

  const values = {
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
    includeMemories: fields.includeMemories ?? CREATE_DEFAULTS.includeMemories,
    config,
    nextRunAt,
    ...tokenFields,
  };
  const [row] = await db.transaction(async (tx) => {
    if (oneOff) await requireOneOffRoom(tx, ctx);
    return tx.insert(triggerTable).values(values).returning();
  });
  // The token leaves here once, beside the row, and is never readable again:
  // only its hash was stored.
  return token ? { ...row, issuedToken: token } : row;
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
  { allowInbound = false }: TriggerWriteOptions = {},
): Promise<TriggerRow> {
  const existing = await requireOwned(db, "trigger", {
    id: triggerId,
    workspaceId: ctx.workspaceId,
  });
  if (
    !allowInbound &&
    (existing.type === "inbound" || fields.type === "inbound")
  ) {
    throw new ValidationError(INBOUND_ONLY_IN_UI);
  }
  // A type change into or out of `inbound` would mint or orphan a credential
  // as a side effect of an edit, so neither surface offers it: an Inbound
  // Trigger is created as one, and its token is shown on creation.
  if (
    fields.type !== undefined &&
    fields.type !== existing.type &&
    (fields.type === "inbound" || existing.type === "inbound")
  ) {
    throw new ValidationError(
      "A trigger's type cannot be changed to or from 'inbound'. Create a new trigger instead.",
    );
  }
  if (existing.firedAt) requireNotReArmed(existing, fields);
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
  /** Whether the update makes this a pending One-off it was not before. */
  let needsOneOffRoom = false;
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
  } else if (effectiveType === "inbound") {
    // A new config does not re-issue the token: a changed `tokenExpiryDays`
    // applies from the next regenerate, so an edit never moves a live expiry.
    if (fields.config !== undefined) {
      updateData.config = parseInboundConfig(fields.config);
    }
  } else if (effectiveType === "cron") {
    if (fields.config !== undefined || fields.type !== undefined) {
      const effectiveConfigInput = fields.config ?? existing.config;
      const parsed = parseCronConfig(effectiveConfigInput);
      needsOneOffRoom =
        parsed.config.isOneOff === true && !isPendingOneOff(existing);
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
      "Invalid trigger type. Must be 'cron', 'event' or 'inbound'.",
    );
  }

  const row = await db.transaction(async (tx) => {
    if (needsOneOffRoom) await requireOneOffRoom(tx, ctx);
    return updateOwned(
      tx,
      "trigger",
      { id: triggerId, workspaceId: ctx.workspaceId },
      updateData,
    );
  });
  if (!row) {
    throw new NotFoundError("Trigger not found");
  }
  return row;
}

/**
 * This Workspace's Triggers, newest first, each with its newest run's status —
 * only the enabled ones when `enabledOnly` is set. Fired One-off Triggers are
 * left out unless `includeFired` is set.
 */
export async function listTriggers(
  ctx: ScopeContext,
  {
    enabledOnly = false,
    includeFired = false,
  }: { enabledOnly?: boolean; includeFired?: boolean } = {},
): Promise<(TriggerRow & { lastRunStatus: TriggerRunStatus | null })[]> {
  const rows = (
    await listOwned(
      db,
      "trigger",
      { workspaceId: ctx.workspaceId },
      desc(triggerTable.createdAt),
    )
  ).filter(
    (row) => (!enabledOnly || row.enabled) && (includeFired || !row.firedAt),
  );
  if (rows.length === 0) return [];

  // Each Trigger's newest run only, however many it keeps.
  const runs = await db
    .selectDistinctOn([triggerRunTable.triggerId], {
      triggerId: triggerRunTable.triggerId,
      status: triggerRunTable.status,
    })
    .from(triggerRunTable)
    .where(
      inArray(
        triggerRunTable.triggerId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(triggerRunTable.triggerId), desc(triggerRunTable.startedAt));
  const lastStatus = new Map(
    runs.map((run) => [run.triggerId, run.status as TriggerRunStatus]),
  );
  return rows.map((row) => ({
    ...row,
    lastRunStatus: lastStatus.get(row.id) ?? null,
  }));
}

/** A Trigger in this Workspace. Throws `NotFoundError` when not here. */
export const getTrigger = (
  ctx: ScopeContext,
  triggerId: string,
): Promise<TriggerRow> =>
  requireOwned(db, "trigger", { id: triggerId, workspaceId: ctx.workspaceId });

/**
 * Deletes a Trigger in this Workspace; `false` when none was here. An Inbound
 * Trigger only on the Owner's surface: an inbound run's context carries
 * caller-supplied text, and an Agent talked into deleting its own integration
 * would stop it with nothing but a uniform `404` to show for it (ADR-0030).
 * The type is read first, then the row deleted — safe because no edit moves a
 * Trigger's type to or from `inbound`.
 */
export const deleteTrigger = async (
  ctx: ScopeContext,
  triggerId: string,
  { allowInbound = false }: TriggerWriteOptions = {},
): Promise<boolean> => {
  const ref = { id: triggerId, workspaceId: ctx.workspaceId };
  if (!allowInbound) {
    const existing = await resolveOwned(db, "trigger", ref);
    if (existing?.type === "inbound") {
      throw new ValidationError(INBOUND_ONLY_IN_UI);
    }
  }
  return deleteOwned(db, "trigger", ref);
};

/**
 * Issues a new token for an Inbound Trigger in this Workspace, invalidating
 * the old one at once, with the lifetime its config names from now. Returns
 * the token — the only time it is readable. Throws `NotFoundError` when the
 * Trigger is not here, `ValidationError` when it is not inbound.
 */
export async function regenerateTriggerToken(
  ctx: ScopeContext,
  triggerId: string,
): Promise<{ token: string; tokenExpiresAt: Date }> {
  const existing = await requireOwned(db, "trigger", {
    id: triggerId,
    workspaceId: ctx.workspaceId,
  });
  if (existing.type !== "inbound") {
    throw new ValidationError("Only inbound triggers have a token.");
  }
  // A stored config that no longer parses is a Trigger to repair, not a
  // server fault: saving its inputs again rewrites the config.
  const parsed = inboundTriggerConfigSchema.safeParse(existing.config);
  if (!parsed.success) {
    throw new ValidationError(
      "This trigger's configuration is invalid. Save its inputs again, then regenerate the token.",
    );
  }
  const { token, hash } = generateBearerToken(INBOUND_TOKEN_PREFIX);
  const fields = issuedTokenFields(hash, parsed.data.tokenExpiryDays);
  const row = await updateOwned(
    db,
    "trigger",
    { id: triggerId, workspaceId: ctx.workspaceId },
    { ...fields, updatedAt: new Date() },
  );
  if (!row) {
    throw new NotFoundError("Trigger not found");
  }
  return { token, tokenExpiresAt: fields.tokenExpiresAt };
}
