import { and, count, eq, gt, isNotNull, lte, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  gateAdmits,
  type OrgGateAccess,
  type OrgGateAccessUpdate,
  type InboundTriggerConfig,
  type OrgGate,
  type InboundTriggerInput,
  type BearerTokenStatus,
  type UnloadedToolSet,
} from "@platypus/schemas";
import { db } from "../index.ts";
import {
  organization as organizationTable,
  organizationMember,
  trigger as triggerTable,
  triggerRun as triggerRunTable,
  user as userTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import { ConflictError } from "../errors.ts";
import { logger } from "../logger.ts";
import { errorMessage } from "../utils/error-message.ts";
import { getGateAccess, setGateAccess } from "./org-gate.ts";
import {
  readPositiveInt,
  shouldSuppressTriggerRun,
} from "./trigger-breaker.ts";
import { ownerMayAct, ownerMembershipJoin } from "./owner-membership.ts";
import { fireTrigger } from "./trigger-firing.ts";
import {
  acceptInboundTriggerRun,
  liveTriggerRun,
  recordSuppressedTriggerRun,
  triggerRunsEnded,
  type EndedTriggerRun,
} from "./trigger-run-lifecycle.ts";
import { narrowTriggerConfig, type TriggerRow } from "./trigger.ts";
import {
  bearerToken,
  bearerTokenStatus,
  DAY_MS,
  dueReminder,
  hashBearerToken,
  noticeDate,
  notifyTokenOwner,
  TOKEN_REPLACED_MESSAGE,
  revokedTokenFields,
  sendTokenNotice,
  touchToken,
} from "./bearer-token.ts";
import { isRecord } from "../utils/is-record.ts";

export type InboundTriggerSettings = {
  maxConcurrentRuns: number;
  maxBodyBytes: number;
};

const DEFAULT_INBOUND_TRIGGER_MAX_CONCURRENT_RUNS = 10;
const DEFAULT_INBOUND_TRIGGER_MAX_BODY_BYTES = 65536;

export const inboundTriggerSettings = (
  env: NodeJS.ProcessEnv = process.env,
): InboundTriggerSettings => ({
  maxConcurrentRuns: readPositiveInt(
    "INBOUND_TRIGGER_MAX_CONCURRENT_RUNS",
    DEFAULT_INBOUND_TRIGGER_MAX_CONCURRENT_RUNS,
    env,
  ),
  maxBodyBytes: readPositiveInt(
    "INBOUND_TRIGGER_MAX_BODY_BYTES",
    DEFAULT_INBOUND_TRIGGER_MAX_BODY_BYTES,
    env,
  ),
});

export const validateInboundTriggerSettings = (): InboundTriggerSettings => {
  const settings = inboundTriggerSettings();
  logger.info(settings, "Inbound triggers configured");
  return settings;
};

export const INBOUND_RETRY_AFTER_SECONDS = 30;

export type InboundCallOutcome =
  "accepted" | "deduplicated" | "suppressed" | "rejected" | "rate_limited";

export type InboundRejectReason =
  | "unknown_trigger"
  | "not_inbound"
  | "missing_token"
  | "bad_token"
  | "expired_token"
  | "disabled"
  | "gate"
  | "owner_left"
  | "misconfigured"
  | "invalid_inputs"
  | "body_too_large"
  | "internal_error";

export type InboundCallLogEntry = {
  triggerId: string;
  organizationId?: string;
  workspaceId?: string;
  outcome: InboundCallOutcome;
  reason?: InboundRejectReason;
  runId?: string;
  deduplicated?: boolean;
  recordKey?: string;
};

export const INBOUND_CALL_LOG_MESSAGE = "Inbound trigger call";

export const logInboundCall = (entry: InboundCallLogEntry): void => {
  logger.info(
    {
      organizationId: entry.organizationId ?? null,
      workspaceId: entry.workspaceId ?? null,
      triggerId: entry.triggerId,
      outcome: entry.outcome,
      reason: entry.reason ?? null,
      runId: entry.runId ?? null,
      deduplicated: entry.deduplicated ?? null,
      recordKey: entry.recordKey ?? null,
    },
    INBOUND_CALL_LOG_MESSAGE,
  );
};

export type InboundTarget = {
  trigger: TriggerRow;
  organizationId: string;
  workspaceId: string;
  gate: OrgGate;
  workspaceAllowed: boolean;
  ownerMayAct: boolean;
};

export const loadInboundTarget = async (
  triggerId: string,
): Promise<InboundTarget | null> => {
  const [row] = await db
    .select()
    .from(triggerTable)
    .innerJoin(workspaceTable, eq(workspaceTable.id, triggerTable.workspaceId))
    .innerJoin(
      organizationTable,
      eq(organizationTable.id, workspaceTable.organizationId),
    )
    .innerJoin(userTable, eq(userTable.id, workspaceTable.ownerId))
    .leftJoin(organizationMember, ownerMembershipJoin())
    .where(eq(triggerTable.id, triggerId))
    .limit(1);
  if (!row) return null;
  return {
    trigger: row.trigger,
    organizationId: row.organization.id,
    workspaceId: row.workspace.id,
    gate: row.organization.inboundTriggerGate,
    workspaceAllowed: row.workspace.inboundTriggersAllowed,
    ownerMayAct: ownerMayAct({
      membershipId: row.organization_member?.id,
      role: row.user.role,
      banned: row.user.banned,
      banExpires: row.user.banExpires,
    }),
  };
};

export type InboundAuthResult =
  | { ok: true; target: InboundTarget; config: InboundTriggerConfig }
  | { ok: false; reason: InboundRejectReason; target: InboundTarget | null };

export const authenticateInboundCall = async (
  triggerId: string,
  authorization: string | undefined,
  now: Date = new Date(),
): Promise<InboundAuthResult> => {
  const target = await loadInboundTarget(triggerId);
  if (!target) return { ok: false, reason: "unknown_trigger", target: null };
  const { trigger } = target;
  if (trigger.type !== "inbound") {
    return { ok: false, reason: "not_inbound", target };
  }

  const token = bearerToken(authorization);
  if (!token) return { ok: false, reason: "missing_token", target };
  if (!trigger.tokenHash || trigger.tokenHash !== hashBearerToken(token)) {
    return { ok: false, reason: "bad_token", target };
  }
  if (!trigger.tokenExpiresAt || trigger.tokenExpiresAt <= now) {
    await noticeExpiredTokenUse(target);
    return { ok: false, reason: "expired_token", target };
  }
  if (!trigger.enabled) return { ok: false, reason: "disabled", target };
  if (!gateAdmits(target.gate, target.workspaceAllowed)) {
    return { ok: false, reason: "gate", target };
  }
  if (!target.ownerMayAct) {
    return { ok: false, reason: "owner_left", target };
  }

  try {
    const typed = narrowTriggerConfig(trigger);
    if (typed.type !== "inbound") throw new Error("not inbound");
    return { ok: true, target, config: typed.config };
  } catch (error) {
    logger.error(
      {
        triggerId,
        error: errorMessage(error),
      },
      "Inbound trigger row is malformed; call refused",
    );
    return { ok: false, reason: "misconfigured", target };
  }
};

export type InputValidation =
  { ok: true; inputs: Record<string, string> } | { ok: false; message: string };

export const validateInboundBody = (
  body: unknown,
  declared: InboundTriggerInput[],
): InputValidation => {
  if (body === undefined) body = {};
  if (!isRecord(body)) {
    return { ok: false, message: "The request body must be a JSON object." };
  }
  const unexpected = Object.keys(body).filter((key) => key !== "inputs");
  if (unexpected.length) {
    return {
      ok: false,
      message: `Unexpected field '${unexpected[0]}'. The body is { "inputs": { ... } }.`,
    };
  }
  const raw = Object.hasOwn(body, "inputs") ? body.inputs : {};
  if (!isRecord(raw)) {
    return { ok: false, message: "'inputs' must be a JSON object." };
  }

  const names = new Set(declared.map((input) => input.name));
  for (const [name, value] of Object.entries(raw)) {
    if (!names.has(name)) {
      return { ok: false, message: `Input '${name}' is not declared.` };
    }
    if (typeof value !== "string") {
      return { ok: false, message: `Input '${name}' must be a string.` };
    }
  }
  for (const input of declared) {
    if (input.required && !Object.hasOwn(raw, input.name)) {
      return {
        ok: false,
        message: `Required input '${input.name}' is missing.`,
      };
    }
  }
  return { ok: true, inputs: raw as Record<string, string> };
};

let activeInboundRuns = 0;

const tryAcquireRunSlot = (max: number): boolean => {
  if (activeInboundRuns >= max) return false;
  activeInboundRuns += 1;
  return true;
};

const releaseRunSlot = (): void => {
  activeInboundRuns -= 1;
};

export const activeInboundRunCount = (): number => activeInboundRuns;

export const resetInboundRunSlots = (): void => {
  activeInboundRuns = 0;
};

const localTurns = new Map<string, Promise<void>>();

const inLocalTurn = async <T>(key: string, work: () => Promise<T>) => {
  const previous = localTurns.get(key) ?? Promise.resolve();
  const turn = previous.then(work);
  const settled = turn.then(
    () => undefined,
    () => undefined,
  );
  localTurns.set(key, settled);
  try {
    return await turn;
  } finally {
    if (localTurns.get(key) === settled) localTurns.delete(key);
  }
};

export const inboundEntityId = (
  trigger: Pick<TriggerRow, "id">,
  config: InboundTriggerConfig,
  inputs: Record<string, string>,
): string => {
  if (config.recordKey === undefined) return trigger.id;
  const entityId = inputs[config.recordKey];
  if (entityId === undefined) {
    throw new Error(`Inbound call has no '${config.recordKey}' input`);
  }
  return entityId;
};

export type InboundAcceptance =
  | { outcome: "accepted"; runId: string }
  | { outcome: "deduplicated"; runId: string }
  | { outcome: "suppressed"; runId: string }
  | { outcome: "rate_limited" };

// why: suppressed row is settled after commit, never inside the tx, which could still roll back
type AcceptanceDecision =
  | { outcome: "accepted"; runId: string }
  | { outcome: "deduplicated"; runId: string }
  | { outcome: "suppressed"; runId: string; suppressed: EndedTriggerRun }
  | { outcome: "rate_limited" };

export const acceptInboundCall = async (
  target: InboundTarget,
  config: InboundTriggerConfig,
  inputs: Record<string, string>,
  settings: InboundTriggerSettings = inboundTriggerSettings(),
): Promise<InboundAcceptance> => {
  const { trigger } = target;
  const entityId = inboundEntityId(trigger, config, inputs);
  const lockKey = `inbound:${trigger.id}:${entityId}`;
  let holdsSlot = false;
  let decision: AcceptanceDecision;
  try {
    decision = await inLocalTurn(lockKey, () =>
      db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
        );

        if (config.recordKey !== undefined) {
          const [active] = await tx
            .select({ id: triggerRunTable.id })
            .from(triggerRunTable)
            .where(
              and(
                eq(triggerRunTable.triggerId, trigger.id),
                eq(triggerRunTable.entityId, entityId),
                liveTriggerRun(),
              ),
            )
            .limit(1);
          if (active) {
            return { outcome: "deduplicated" as const, runId: active.id };
          }
        }

        const suppress = await shouldSuppressTriggerRun(
          trigger.id,
          entityId,
          tx,
        );
        if (!suppress) {
          if (!tryAcquireRunSlot(settings.maxConcurrentRuns)) {
            return { outcome: "rate_limited" as const };
          }
          holdsSlot = true;
        }
        const runId = nanoid();
        if (suppress) {
          const suppressed = await recordSuppressedTriggerRun(tx, {
            runId,
            triggerId: trigger.id,
            entityId,
            eventData: { inputs },
          });
          return { outcome: "suppressed" as const, runId, suppressed };
        }
        await acceptInboundTriggerRun(tx, {
          runId,
          triggerId: trigger.id,
          entityId,
          inputs,
        });
        return { outcome: "accepted" as const, runId };
      }),
    );
  } catch (error) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- set in a callback, which TS narrowing does not track
    if (holdsSlot) releaseRunSlot();
    throw error;
  }

  if (decision.outcome === "rate_limited") return decision;
  if (decision.outcome === "suppressed") {
    await triggerRunsEnded([decision.suppressed]);
  }
  if (decision.outcome === "accepted") {
    startAcceptedRun(trigger, config, inputs, entityId, decision.runId);
  }
  return { outcome: decision.outcome, runId: decision.runId };
};

const startAcceptedRun = (
  trigger: TriggerRow,
  config: InboundTriggerConfig,
  inputs: Record<string, string>,
  entityId: string,
  runId: string,
): void => {
  void fireTrigger(trigger, {
    kind: "inbound",
    runId,
    inputs,
    declared: config.inputs,
    entityId,
  }).finally(releaseRunSlot);
};

export const touchInboundTrigger = (
  triggerId: string,
  column: "lastUsedAt" | "lastRejectedAt",
  now: Date = new Date(),
): Promise<void> => touchToken(triggerTable, triggerId, column, now);

export type InboundRunStatus = {
  runId: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  errorMessage: string | null;
  unloadedToolSets: UnloadedToolSet[];
  failedToolCalls: number;
};

export const getInboundRunStatus = async (
  triggerId: string,
  runId: string,
): Promise<InboundRunStatus | null> => {
  const [run] = await db
    .select({
      runId: triggerRunTable.id,
      status: triggerRunTable.status,
      startedAt: triggerRunTable.startedAt,
      completedAt: triggerRunTable.completedAt,
      errorMessage: triggerRunTable.errorMessage,
      unloadedToolSets: triggerRunTable.unloadedToolSets,
      failedToolCalls: triggerRunTable.failedToolCalls,
    })
    .from(triggerRunTable)
    .where(
      and(
        eq(triggerRunTable.id, runId),
        eq(triggerRunTable.triggerId, triggerId),
      ),
    )
    .limit(1);
  return run ?? null;
};

const noticeExpiredTokenUse = async (target: InboundTarget): Promise<void> => {
  const { trigger } = target;
  const { tokenHash } = trigger;
  if (!tokenHash) return;
  const expired = trigger.tokenExpiresAt
    ? ` on ${noticeDate(trigger.tokenExpiresAt)}`
    : "";
  await sendTokenNotice(
    triggerTable,
    { ...trigger, tokenHash },
    "expired",
    target.organizationId,
    trigger,
    "Inbound trigger token has expired",
    `A call to the inbound trigger "${trigger.name}" used its token after it expired${expired}, and was refused. Regenerate the token on the trigger's page and update the system that calls it.`,
  );
};

export const sendInboundTokenReminders = async (
  now: Date = new Date(),
): Promise<void> => {
  const rows = await db
    .select()
    .from(triggerTable)
    .innerJoin(workspaceTable, eq(workspaceTable.id, triggerTable.workspaceId))
    .where(
      and(
        eq(triggerTable.type, "inbound"),
        isNotNull(triggerTable.tokenHash),
        gt(triggerTable.tokenExpiresAt, now),
        lte(triggerTable.tokenExpiresAt, new Date(now.getTime() + 30 * DAY_MS)),
      ),
    );

  for (const row of rows) {
    const trigger = row.trigger;
    const { tokenHash, tokenExpiresAt } = trigger;
    if (!tokenHash || !tokenExpiresAt) continue;
    const due = dueReminder(
      { tokenCreatedAt: trigger.tokenCreatedAt, tokenExpiresAt },
      now,
    );
    if (!due) continue;
    await sendTokenNotice(
      triggerTable,
      { ...trigger, tokenHash },
      due,
      row.workspace.organizationId,
      trigger,
      "Inbound trigger token expires soon",
      `The token for the inbound trigger "${trigger.name}" expires on ${noticeDate(tokenExpiresAt)}. Regenerate it on the trigger's page and update the system that calls it; calls with the current token are refused once it expires.`,
    );
  }
};

export type OrgInboundTrigger = {
  id: string;
  name: string;
  enabled: boolean;
  workspaceId: string;
  workspaceName: string;
  ownerId: string;
  ownerName: string;
  createdAt: Date;
  tokenStatus: BearerTokenStatus;
  tokenCreatedAt: Date | null;
  tokenExpiresAt: Date | null;
  lastUsedAt: Date | null;
  lastRejectedAt: Date | null;
};

export const listOrgInboundTriggers = async (
  orgId: string,
  now: Date = new Date(),
): Promise<OrgInboundTrigger[]> => {
  const rows = await db
    .select()
    .from(triggerTable)
    .innerJoin(workspaceTable, eq(workspaceTable.id, triggerTable.workspaceId))
    .innerJoin(userTable, eq(userTable.id, workspaceTable.ownerId))
    .where(
      and(
        eq(workspaceTable.organizationId, orgId),
        eq(triggerTable.type, "inbound"),
      ),
    );
  return rows
    .map(({ trigger, workspace, user }) => ({
      id: trigger.id,
      name: trigger.name,
      enabled: trigger.enabled,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      ownerId: user.id,
      ownerName: user.name,
      createdAt: trigger.createdAt,
      tokenStatus: bearerTokenStatus(trigger, now),
      tokenCreatedAt: trigger.tokenCreatedAt,
      tokenExpiresAt: trigger.tokenExpiresAt,
      lastUsedAt: trigger.lastUsedAt,
      lastRejectedAt: trigger.lastRejectedAt,
    }))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
};

export const revokeInboundTriggerToken = async (
  orgId: string,
  triggerId: string,
  seenTokenCreatedAt: Date,
): Promise<boolean> => {
  const [row] = await db
    .select()
    .from(triggerTable)
    .innerJoin(workspaceTable, eq(workspaceTable.id, triggerTable.workspaceId))
    .where(
      and(
        eq(triggerTable.id, triggerId),
        eq(triggerTable.type, "inbound"),
        eq(workspaceTable.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!row) return false;
  const { tokenHash, tokenCreatedAt } = row.trigger;
  if (!tokenHash) return true;

  if (tokenCreatedAt?.getTime() !== seenTokenCreatedAt.getTime()) {
    throw new ConflictError(TOKEN_REPLACED_MESSAGE);
  }
  const revoked = await db
    .update(triggerTable)
    .set({ ...revokedTokenFields(), updatedAt: new Date() })
    .where(
      and(
        eq(triggerTable.id, triggerId),
        eq(triggerTable.tokenHash, tokenHash),
      ),
    )
    .returning({ id: triggerTable.id });
  if (revoked.length === 0) {
    throw new ConflictError(TOKEN_REPLACED_MESSAGE);
  }

  await notifyTokenOwner(
    orgId,
    row.trigger,
    "Inbound trigger token revoked",
    `An Organization Admin revoked the token for the inbound trigger "${row.trigger.name}", so calls with it are refused. If the integration should keep working, regenerate the token on the trigger's page and update the system that calls it.`,
  );
  logger.info(
    { triggerId, organizationId: orgId, workspaceId: row.workspace.id },
    "Inbound trigger token revoked by an Org Admin",
  );
  return true;
};

const INBOUND_GATE = {
  gate: "inboundTriggerGate",
  allowed: "inboundTriggersAllowed",
  resourceCounts: (orgId: string) =>
    db
      .select({ workspaceId: triggerTable.workspaceId, count: count() })
      .from(triggerTable)
      .innerJoin(
        workspaceTable,
        eq(workspaceTable.id, triggerTable.workspaceId),
      )
      .where(
        and(
          eq(workspaceTable.organizationId, orgId),
          eq(triggerTable.type, "inbound"),
        ),
      )
      .groupBy(triggerTable.workspaceId),
  changedMessage: "Inbound trigger access changed by an Org Admin",
} as const;

export const getInboundTriggerAccess = (
  orgId: string,
): Promise<OrgGateAccess> => getGateAccess(INBOUND_GATE, orgId);

export const setInboundTriggerAccess = (
  orgId: string,
  update: OrgGateAccessUpdate,
  actorUserId: string,
): Promise<OrgGateAccess> =>
  setGateAccess(INBOUND_GATE, orgId, update, actorUserId);
