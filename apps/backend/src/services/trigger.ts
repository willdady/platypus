import { nanoid } from "nanoid";
import { asc, desc, eq, inArray } from "drizzle-orm";
import {
  cronTriggerConfigSchema,
  eventTriggerConfigSchema,
  inboundTriggerConfigSchema,
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
import { nextCronRunAt } from "../utils/cron.ts";
import {
  generateBearerToken,
  bearerTokenStatus,
  issuedTokenFields,
} from "./bearer-token.ts";
import { resolveScoped } from "./scoped-resource.ts";
import {
  listOwned,
  ownedWhere,
  requireOwned,
  updateOwned,
} from "./workspace-resource.ts";
import { oneRow } from "../db/one-row.ts";
import { deleteTriggerRunFiles } from "./trigger-run-files.ts";

const INBOUND_TOKEN_PREFIX = "pit_";

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
  includeMemories: boolean;
  extractMemories: boolean;
  config: CronTriggerConfig | EventTriggerConfig | InboundTriggerConfig;
};

export type TriggerWriteOptions = { allowInbound: boolean };

export type TriggerCreateFields = TriggerBaseFields & {
  issueToken?: boolean;
};

export type TriggerUpdateFields = Partial<Omit<TriggerBaseFields, "config">> & {
  config?: unknown;
};

export type TypedTriggerConfig =
  | { type: "cron"; config: CronTriggerConfig }
  | { type: "event"; config: EventTriggerConfig }
  | { type: "inbound"; config: InboundTriggerConfig };

export const narrowTriggerConfig = (
  row: Pick<TriggerRow, "id" | "type" | "config">,
): TypedTriggerConfig => {
  if (row.type === "cron") {
    const parsed = cronTriggerConfigSchema.safeParse(row.config);
    if (parsed.success) return { type: "cron", config: parsed.data };
  } else if (row.type === "event") {
    const parsed = eventTriggerConfigSchema.safeParse(row.config);
    if (parsed.success) return { type: "event", config: parsed.data };
  } else {
    const parsed = inboundTriggerConfigSchema.safeParse(row.config);
    if (parsed.success) return { type: "inbound", config: parsed.data };
  }
  throw new Error(
    `Trigger '${row.id}' has a malformed '${row.type}' type/config pair`,
  );
};

export { nextCronRunAt };

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

const parseEventConfig = (config: unknown): EventTriggerConfig => {
  const parsed = eventTriggerConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new ValidationError(
      "Event triggers require config.events: a non-empty array of valid event names, and, if present, a valid config.filters object.",
    );
  }
  return parsed.data;
};

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

export const MAX_PENDING_ONE_OFF_TRIGGERS = 50;

export const FIRED_ONE_OFF_TTL_DAYS = 7;

const isPendingOneOff = (
  row: Pick<TriggerRow, "id" | "type" | "config" | "firedAt">,
): boolean => {
  if (row.type !== "cron" || row.firedAt) return false;
  const typed = narrowTriggerConfig(row);
  return typed.type === "cron" && typed.config.isOneOff === true;
};

const requireOneOffRoom = async (tx: Tx, ctx: ScopeContext): Promise<void> => {
  await tx
    .select({ id: workspaceTable.id })
    .from(workspaceTable)
    .where(eq(workspaceTable.id, ctx.workspaceId))
    // why: serialises concurrent writes, so the pending count can't pass the limit
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

const requireNotReArmed = (
  existing: TriggerRow,
  fields: TriggerUpdateFields,
): void => {
  const storedPair = narrowTriggerConfig(existing);
  const stored = storedPair.type === "cron" ? storedPair.config : undefined;
  const next =
    fields.config === undefined
      ? stored
      : parseCronConfig(fields.config).config;
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

export const toPublicTrigger = (row: TriggerRow) => {
  const { tokenHash: _tokenHash, tokenNotice: _tokenNotice, ...rest } = row;
  return {
    ...rest,
    tokenStatus: bearerTokenStatus(row),
  };
};

const requireUsableAgent = async (
  ctx: ScopeContext,
  agentId: string,
): Promise<void> => {
  if (!(await resolveScoped(db, "agent", agentId, ctx))) {
    throw new ValidationError("Agent not found in this workspace");
  }
};

export async function createTrigger(
  ctx: ScopeContext,
  fields: TriggerCreateFields,
  { allowInbound }: TriggerWriteOptions,
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
  } else {
    fields.type satisfies "inbound";
    const inbound = parseInboundConfig(fields.config);
    config = inbound;
    if (fields.issueToken !== false) {
      const generated = generateBearerToken(INBOUND_TOKEN_PREFIX);
      token = generated.token;
      tokenFields = issuedTokenFields(generated.hash, inbound.tokenExpiryDays);
    }
  }

  const values = {
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
    includeMemories: fields.includeMemories,
    extractMemories: fields.extractMemories,
    config,
    nextRunAt,
    ...tokenFields,
  };
  const row = oneRow(
    await db.transaction(async (tx) => {
      if (oneOff) await requireOneOffRoom(tx, ctx);
      return tx.insert(triggerTable).values(values).returning();
    }),
  );
  return token ? { ...row, issuedToken: token } : row;
}

export async function updateTrigger(
  ctx: ScopeContext,
  triggerId: string,
  fields: TriggerUpdateFields,
  { allowInbound }: TriggerWriteOptions,
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
  const effectiveType: TriggerType = fields.type ?? existing.type;

  const updateData: Partial<TriggerRow> = {
    updatedAt: new Date(),
  };
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
  if (fields.extractMemories !== undefined)
    updateData.extractMemories = fields.extractMemories;
  if (fields.type !== undefined) updateData.type = fields.type;

  if (effectiveType === "event") {
    if (fields.config !== undefined || fields.type !== undefined) {
      const parsed = parseEventConfig(fields.config ?? existing.config);
      if (fields.config !== undefined) {
        updateData.config = parsed;
      }
    }
    updateData.nextRunAt = null;
  } else if (effectiveType === "inbound") {
    if (fields.config !== undefined) {
      updateData.config = parseInboundConfig(fields.config);
    }
  } else {
    effectiveType satisfies "cron";
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
      updateData.nextRunAt = parseCronConfig(existing.config).nextRunAt;
    }
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

export async function listTriggers(
  ctx: ScopeContext,
  {
    enabledOnly,
    includeFired,
  }: { enabledOnly: boolean; includeFired: boolean },
): Promise<
  (TriggerRow & {
    lastRunStatus: TriggerRunStatus | null;
    lastRunStartedAt: Date | null;
  })[]
> {
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

  const runs = await db
    .selectDistinctOn([triggerRunTable.triggerId], {
      triggerId: triggerRunTable.triggerId,
      status: triggerRunTable.status,
      startedAt: triggerRunTable.startedAt,
    })
    .from(triggerRunTable)
    .where(
      inArray(
        triggerRunTable.triggerId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(triggerRunTable.triggerId), desc(triggerRunTable.startedAt));
  const lastRun = new Map(runs.map((run) => [run.triggerId, run]));
  return rows.map((row) => {
    const run = lastRun.get(row.id);
    return {
      ...row,
      lastRunStatus: run?.status ?? null,
      lastRunStartedAt: run?.startedAt ?? null,
    };
  });
}

export const getTrigger = (
  ctx: ScopeContext,
  triggerId: string,
): Promise<TriggerRow> =>
  requireOwned(db, "trigger", { id: triggerId, workspaceId: ctx.workspaceId });

export const deleteTrigger = async (
  ctx: ScopeContext,
  triggerId: string,
  { allowInbound }: TriggerWriteOptions,
): Promise<boolean> => {
  const ref = { id: triggerId, workspaceId: ctx.workspaceId };
  const runIds = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(triggerTable)
      .where(ownedWhere("trigger", ref))
      // why: a run started between this read and the delete would leave its files behind
      .for("update");
    if (!existing) return null;
    if (!allowInbound && existing.type === "inbound") {
      throw new ValidationError(INBOUND_ONLY_IN_UI);
    }

    const ids = (
      await tx
        .select({ id: triggerRunTable.id })
        .from(triggerRunTable)
        .where(eq(triggerRunTable.triggerId, triggerId))
    ).map(({ id }) => id);

    await tx.delete(triggerTable).where(ownedWhere("trigger", ref));
    return ids;
  });

  if (!runIds) return false;

  await deleteTriggerRunFiles(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
    runIds,
  );
  return true;
};

export async function regenerateTriggerToken(
  ctx: ScopeContext,
  triggerId: string,
): Promise<{ token: string; tokenExpiresAt: Date }> {
  const existing = await requireOwned(db, "trigger", {
    id: triggerId,
    workspaceId: ctx.workspaceId,
  });
  const typed = narrowTriggerConfig(existing);
  if (typed.type !== "inbound") {
    throw new ValidationError("Only inbound triggers have a token.");
  }
  const { token, hash } = generateBearerToken(INBOUND_TOKEN_PREFIX);
  const fields = issuedTokenFields(hash, typed.config.tokenExpiryDays);
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
