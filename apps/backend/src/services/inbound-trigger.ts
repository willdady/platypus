import {
  and,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { nanoid } from "nanoid";
import type {
  InboundTriggerAccess,
  InboundTriggerAccessUpdate,
  InboundTriggerConfig,
  InboundTriggerGate,
  InboundTriggerInput,
  InboundTokenStatus,
} from "@platypus/schemas";
import { db } from "../index.ts";
import {
  organization as organizationTable,
  trigger as triggerTable,
  triggerRun as triggerRunTable,
  user as userTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import { ConflictError } from "../errors.ts";
import { logger } from "../logger.ts";
import { errorMessage } from "../utils/error-message.ts";
import { createNotification } from "./notification.ts";
import {
  gateAdmits,
  getGateAccess,
  setGateAccess,
  type GateAccess,
} from "./org-gate.ts";
import {
  readPositiveInt,
  retainTriggerRuns,
  shouldSuppressTriggerRun,
} from "./trigger-breaker.ts";
import { fireTrigger } from "./trigger-firing.ts";
import { narrowTriggerConfig, type TriggerRow } from "./trigger.ts";
import {
  DAY_MS,
  inboundTokenMatches,
  inboundTokenStatus,
  revokedTokenFields,
  tokenNoticeSent,
  type TokenNotice,
} from "./inbound-trigger-token.ts";

/**
 * Inbound Triggers (ADR-0030): the backend's one ingress that is not a
 * browser session. An external caller fires one Trigger with that Trigger's
 * bearer token, and the call becomes a Trigger run through the ordinary firing
 * path.
 *
 * This module owns everything between the HTTP route and `fireTrigger`: which
 * calls are let in (token, expiry, enabled, the Organization gate), what a
 * body may carry, the per-record dedup and the breaker verdict, the pending
 * run row whose id the caller gets back, the server-wide cap on active inbound
 * runs, and the one log line every call writes. The route only maps these
 * verdicts onto status codes.
 */

// ----------------------------------------------------------------- settings

export type InboundTriggerSettings = {
  /** Inbound runs this backend instance will have active at once. */
  maxConcurrentRuns: number;
  /** The largest request body the fire endpoint reads, in bytes. */
  maxBodyBytes: number;
};

export const inboundTriggerSettings = (
  env: NodeJS.ProcessEnv = process.env,
): InboundTriggerSettings => ({
  maxConcurrentRuns: readPositiveInt(
    "INBOUND_TRIGGER_MAX_CONCURRENT_RUNS",
    10,
    env,
  ),
  maxBodyBytes: readPositiveInt("INBOUND_TRIGGER_MAX_BODY_BYTES", 65536, env),
});

/**
 * Validates the settings and reports them at boot, so a malformed value fails
 * the deployment instead of being replaced by a default nobody chose — the
 * rule the breaker settings follow.
 */
export const validateInboundTriggerSettings = (): InboundTriggerSettings => {
  const settings = inboundTriggerSettings();
  logger.info(settings, "Inbound triggers configured");
  return settings;
};

/** Seconds a caller over the concurrency cap is told to wait. */
export const INBOUND_RETRY_AFTER_SECONDS = 30;

// ----------------------------------------------------------------- call log

/** What happened to one call to the fire endpoint. */
export type InboundCallOutcome =
  "accepted" | "deduplicated" | "suppressed" | "rejected" | "rate_limited";

/** Why a call was rejected. Only the log says; the caller sees the status. */
export type InboundRejectReason =
  | "unknown_trigger"
  | "not_inbound"
  | "missing_token"
  | "bad_token"
  | "expired_token"
  | "disabled"
  | "gate"
  | "misconfigured"
  | "invalid_inputs"
  | "body_too_large"
  /** The backend failed while handling the call; it answers `500`. */
  | "internal_error";

export type InboundCallLogEntry = {
  triggerId: string;
  organizationId?: string;
  workspaceId?: string;
  outcome: InboundCallOutcome;
  reason?: InboundRejectReason;
  runId?: string;
  deduplicated?: boolean;
  /** The record key's value. Never any other input. */
  recordKey?: string;
};

/** The call log line's message. Documented, and so not to be changed. */
export const INBOUND_CALL_LOG_MESSAGE = "Inbound trigger call";

/**
 * The one line every call to the fire endpoint writes, whatever its outcome
 * (ADR-0030). Its message, fields and values are a documented format an
 * Operator's log tooling relies on: every field is present on every line,
 * `null` where it does not apply, so a missing key never has to be told apart
 * from an absent value. No input value other than the record key's.
 */
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

// ----------------------------------------------------------------- lookup

/** An Inbound Trigger call's target, with what the gate and the log need. */
export type InboundTarget = {
  trigger: TriggerRow;
  organizationId: string;
  workspaceId: string;
  gate: InboundTriggerGate;
  workspaceAllowed: boolean;
};

/** The Trigger a call names, joined to its Workspace and Organization. */
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
    .where(eq(triggerTable.id, triggerId))
    .limit(1);
  if (!row) return null;
  return {
    trigger: row.trigger,
    organizationId: row.organization.id,
    workspaceId: row.workspace.id,
    gate: row.organization.inboundTriggerGate as InboundTriggerGate,
    workspaceAllowed: row.workspace.inboundTriggersAllowed,
  };
};

/**
 * The token an `Authorization: Bearer <token>` header carries, or `null`.
 * The header is the only place a token is read from — never the query string,
 * which proxies and access logs record.
 */
export const bearerToken = (header: string | undefined): string | null => {
  const match = header?.match(/^Bearer\s+(\S+)\s*$/i);
  return match ? match[1] : null;
};

export type InboundAuthResult =
  | { ok: true; target: InboundTarget; config: InboundTriggerConfig }
  | { ok: false; reason: InboundRejectReason; target: InboundTarget | null };

/**
 * Whether a call may fire `triggerId`. Every failure is reported with its
 * reason for the log, and the route answers all of them with the same `404`:
 * only a caller holding a valid token learns anything more specific.
 *
 * Checked in an order that keeps it so. The token comes before `enabled` and
 * the gate, so a caller without it cannot tell a disabled Trigger from a
 * missing one even by timing a different code path; the gate is read on every
 * call, not when the Trigger was made.
 */
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
  if (!trigger.tokenHash || !inboundTokenMatches(token, trigger.tokenHash)) {
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

// ----------------------------------------------------------------- inputs

export type InputValidation =
  { ok: true; inputs: Record<string, string> } | { ok: false; message: string };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Validates a call's body — `{ "inputs": { "<name>": "<string>" } }` — against
 * the Trigger's declared inputs. A missing required input, an undeclared one,
 * or a value that is not a string is refused, naming the problem; nothing is
 * truncated or coerced, so what the Agent sees is exactly what was sent. An
 * empty body, or one without `inputs`, is a call with no inputs.
 */
export const validateInboundBody = (
  body: unknown,
  declared: InboundTriggerInput[],
): InputValidation => {
  if (body === undefined) body = {};
  if (!isPlainObject(body)) {
    return { ok: false, message: "The request body must be a JSON object." };
  }
  const unexpected = Object.keys(body).filter((key) => key !== "inputs");
  if (unexpected.length) {
    return {
      ok: false,
      message: `Unexpected field '${unexpected[0]}'. The body is { "inputs": { ... } }.`,
    };
  }
  // Absent is a call with no inputs; present is taken as sent, so an explicit
  // `null` is refused like any other non-object rather than read as `{}`.
  const raw = Object.hasOwn(body, "inputs") ? body.inputs : {};
  if (!isPlainObject(raw)) {
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
    // `Object.hasOwn`, not `in`: an input named `constructor` or `toString`
    // would otherwise be found on `Object.prototype` and pass unsent.
    if (input.required && !Object.hasOwn(raw, input.name)) {
      return {
        ok: false,
        message: `Required input '${input.name}' is missing.`,
      };
    }
  }
  return { ok: true, inputs: raw as Record<string, string> };
};

// ----------------------------------------------------------------- acceptance

/**
 * The server-wide cap on active inbound runs, held in this process: an
 * inbound run executes in the process that accepted its call, so this is the
 * count that bounds this process's load. A slot is taken only by a call that
 * is about to write a `pending` row — a deduplicated or suppressed call starts
 * no run, so the cap never turns it away — and handed back when the call does
 * not start a run after all or its run ends. Taking it is synchronous, so
 * concurrent calls cannot all pass a check that none has yet acted on.
 */
let activeInboundRuns = 0;

const tryAcquireRunSlot = (max: number): boolean => {
  if (activeInboundRuns >= max) return false;
  activeInboundRuns += 1;
  return true;
};

const releaseRunSlot = (): void => {
  activeInboundRuns -= 1;
};

/** Test seam: the count of slots currently held. */
export const activeInboundRunCount = (): number => activeInboundRuns;

/** Test seam: forget every held slot. */
export const resetInboundRunSlots = (): void => {
  activeInboundRuns = 0;
};

/**
 * Calls waiting for their record's turn in this process, by lock key. The
 * advisory lock is what serialises a record across instances, but a call
 * waiting on it holds a pooled connection the whole time — so a burst at one
 * Trigger with no record key could hold every connection in the pool while
 * all but one of them wait. Queuing here first means a process has at most
 * one connection waiting per record; the rest wait in memory.
 */
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
    // The last call in the queue clears it, so an idle record holds nothing.
    if (localTurns.get(key) === settled) localTurns.delete(key);
  }
};

/**
 * The entity an inbound run is counted and deduplicated under: the record
 * key's value, or — with no key marked — the Trigger's own id, so the breaker
 * caps the whole Trigger and no inbound run is exempt from it.
 */
export const inboundEntityId = (
  trigger: Pick<TriggerRow, "id">,
  config: InboundTriggerConfig,
  inputs: Record<string, string>,
): string =>
  config.recordKey !== undefined ? inputs[config.recordKey] : trigger.id;

export type InboundAcceptance =
  | { outcome: "accepted"; runId: string }
  | { outcome: "deduplicated"; runId: string }
  | { outcome: "suppressed"; runId: string }
  | { outcome: "rate_limited" };

/**
 * Turns an authenticated, validated call into a run id: the active run for
 * this record when there is one, a `suppressed` row when the breaker trips,
 * or a new `pending` row whose run then starts in the background.
 *
 * Dedup, the breaker count and the row it writes are one decision per
 * record: a transaction-scoped advisory lock on (Trigger, entity) makes two
 * simultaneous calls for the same record take turns, so the second sees the
 * first's `pending` row instead of starting a second Agent on it. Calls for
 * different records do not wait for each other.
 */
export const acceptInboundCall = async (
  target: InboundTarget,
  config: InboundTriggerConfig,
  inputs: Record<string, string>,
  settings: InboundTriggerSettings = inboundTriggerSettings(),
): Promise<InboundAcceptance> => {
  const { trigger } = target;
  const entityId = inboundEntityId(trigger, config, inputs);
  const lockKey = `inbound:${trigger.id}:${entityId}`;
  // Whether this call holds a run slot, so every path that does not end in a
  // started run gives it back exactly once.
  let holdsSlot = false;
  let decision: InboundAcceptance;
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
                inArray(triggerRunTable.status, ["pending", "running"]),
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
          // The cap bounds runs, so it is asked only by a call that would start
          // one. Past it, nothing is written: the transaction ends empty.
          if (!tryAcquireRunSlot(settings.maxConcurrentRuns)) {
            return { outcome: "rate_limited" as const };
          }
          holdsSlot = true;
        }
        const runId = nanoid();
        const now = new Date();
        await tx.insert(triggerRunTable).values({
          id: runId,
          triggerId: trigger.id,
          status: suppress ? "suppressed" : "pending",
          entityId,
          eventType: null,
          eventData: { inputs },
          startedAt: now,
          createdAt: now,
        });
        return suppress
          ? { outcome: "suppressed" as const, runId }
          : { outcome: "accepted" as const, runId };
      }),
    );
  } catch (error) {
    if (holdsSlot) releaseRunSlot();
    throw error;
  }

  if (decision.outcome === "suppressed") {
    // A suppressed row is bounded by its own budget; applied here as
    // `suppressTriggerRun` applies it for an Event Trigger.
    await retainTriggerRuns(trigger.id, trigger.maxRunsToKeep).catch(
      (error: unknown) =>
        logger.error(
          {
            triggerId: trigger.id,
            error: errorMessage(error),
          },
          "Failed to apply retention after a suppressed inbound call",
        ),
    );
  }
  if (decision.outcome === "accepted") {
    startAcceptedRun(trigger, config, inputs, entityId, decision.runId);
  }
  return decision;
};

/**
 * Fires an accepted call's run in the background and gives its slot back when
 * the firing ends. `fireTrigger` never rejects; the `finally` is what keeps a
 * slot from leaking if that ever changes.
 */
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

// ----------------------------------------------------------------- last used

const TOUCH_INTERVAL_MS = 60_000;
const lastTouched = new Map<string, number>();

/** Test seam: forget when each Trigger was last touched. */
export const resetInboundTouches = (): void => lastTouched.clear();

/**
 * Stamps `lastUsedAt` or `lastRejectedAt`, at most once a minute per Trigger,
 * so a flood of calls cannot become a flood of writes. Checked in memory
 * first, so a flood costs no query either; the conditional `WHERE` holds the
 * same limit across instances. Best-effort: a failure is logged, never
 * surfaced to the caller.
 */
export const touchInboundTrigger = async (
  triggerId: string,
  column: "lastUsedAt" | "lastRejectedAt",
  now: Date = new Date(),
): Promise<void> => {
  const key = `${triggerId}:${column}`;
  const previous = lastTouched.get(key);
  if (previous !== undefined && now.getTime() - previous < TOUCH_INTERVAL_MS) {
    return;
  }
  lastTouched.set(key, now.getTime());
  const stamped = triggerTable[column];
  try {
    await db
      .update(triggerTable)
      .set({ [column]: now })
      .where(
        and(
          eq(triggerTable.id, triggerId),
          or(
            isNull(stamped),
            lt(stamped, new Date(now.getTime() - TOUCH_INTERVAL_MS)),
          ),
        ),
      );
  } catch (error) {
    logger.error(
      {
        triggerId,
        column,
        error: errorMessage(error),
      },
      "Failed to record inbound trigger use",
    );
  }
};

// ----------------------------------------------------------------- run status

export type InboundRunStatus = {
  runId: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  errorMessage: string | null;
};

/**
 * One of this Trigger's runs, for a caller polling the id it was given:
 * status, timestamps and error, never output. `null` for a run that belongs
 * to another Trigger or that retention has pruned.
 */
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

// ----------------------------------------------------------------- notices

const formatDate = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * Posts a Notification to the Trigger's Workspace, from the Trigger's Agent.
 * `false` — logged — when it could not be posted, so a notice claimed for it
 * can be handed back and sent again.
 */
const notifyOwner = async (
  target: Pick<InboundTarget, "organizationId" | "workspaceId"> & {
    trigger: Pick<TriggerRow, "id" | "agentId">;
  },
  title: string,
  body: string,
): Promise<boolean> => {
  try {
    await createNotification(
      db,
      {
        orgId: target.organizationId,
        workspaceId: target.workspaceId,
        agentId: target.trigger.agentId,
      },
      { title, body },
    );
    return true;
  } catch (error) {
    logger.error(
      {
        triggerId: target.trigger.id,
        error: errorMessage(error),
      },
      "Failed to notify the Workspace Owner about an inbound trigger token",
    );
    return false;
  }
};

/**
 * Records `notice` as sent for the token `tokenHash` names, moving it on from
 * `from`. Conditional on both, so two instances cannot both send it and a
 * token regenerated in the meantime does not inherit the record. `true` when
 * this call is the one that recorded it, and so owes the Notification.
 */
const claimNotice = async (
  triggerId: string,
  tokenHash: string,
  from: string | null,
  notice: TokenNotice,
): Promise<boolean> => {
  const claimed = await db
    .update(triggerTable)
    .set({ tokenNotice: notice })
    .where(
      and(
        eq(triggerTable.id, triggerId),
        eq(triggerTable.tokenHash, tokenHash),
        from === null
          ? isNull(triggerTable.tokenNotice)
          : eq(triggerTable.tokenNotice, from),
      ),
    )
    .returning({ id: triggerTable.id });
  return claimed.length > 0;
};

/**
 * Hands back a notice {@link claimNotice} recorded but whose Notification
 * could not be posted, so the next reminder sweep — or the next call with an
 * expired token — sends it after all. Conditional like the claim, so it never
 * undoes a later notice or reaches a token issued since. Best-effort: a
 * failure is logged, and costs only that one Notification.
 */
const releaseNotice = async (
  triggerId: string,
  tokenHash: string,
  notice: TokenNotice,
  previous: string | null,
): Promise<void> => {
  try {
    await db
      .update(triggerTable)
      .set({ tokenNotice: previous })
      .where(
        and(
          eq(triggerTable.id, triggerId),
          eq(triggerTable.tokenHash, tokenHash),
          eq(triggerTable.tokenNotice, notice),
        ),
      );
  } catch (error) {
    logger.error(
      {
        triggerId,
        notice,
        error: errorMessage(error),
      },
      "Failed to hand back an unsent inbound trigger token notice",
    );
  }
};

/**
 * The first call with an expired token tells the Owner, once per token: the
 * caller only sees the uniform `404`, and many callers do not retry, so
 * nothing else would say a live integration has stopped.
 */
const noticeExpiredTokenUse = async (target: InboundTarget): Promise<void> => {
  const { trigger } = target;
  // Read once, before the claim moves the row on: the hand-back restores this.
  const { tokenHash, tokenNotice: previous } = trigger;
  if (!tokenHash || tokenNoticeSent(previous, "expired")) return;
  try {
    if (!(await claimNotice(trigger.id, tokenHash, previous, "expired"))) {
      return;
    }
  } catch (error) {
    logger.error(
      {
        triggerId: trigger.id,
        error: errorMessage(error),
      },
      "Failed to record an expired inbound trigger token's use",
    );
    return;
  }
  const expired = trigger.tokenExpiresAt
    ? ` on ${formatDate(trigger.tokenExpiresAt)}`
    : "";
  const sent = await notifyOwner(
    target,
    "Inbound trigger token has expired",
    `A call to the inbound trigger "${trigger.name}" used its token after it expired${expired}, and was refused. Regenerate the token on the trigger's page and update the system that calls it.`,
  );
  if (!sent) await releaseNotice(trigger.id, tokenHash, "expired", previous);
};

/**
 * The expiry reminder a token is owed at `now`, if any: 7 days before expiry,
 * or 30 days before it until the 7-day one falls due. A reminder whose moment
 * falls at or before the token was issued is skipped, so a 30-day token only
 * ever gets the 7-day one.
 */
export const dueReminder = (
  token: { tokenCreatedAt: Date | null; tokenExpiresAt: Date },
  now: Date,
): Extract<TokenNotice, "expiring_30" | "expiring_7"> | null => {
  const expires = token.tokenExpiresAt.getTime();
  const created = token.tokenCreatedAt?.getTime() ?? -Infinity;
  const left = expires - now.getTime();
  if (left <= 0) return null;
  const at = (days: number) => expires - days * DAY_MS;
  if (left <= 7 * DAY_MS) return at(7) > created ? "expiring_7" : null;
  if (left <= 30 * DAY_MS) return at(30) > created ? "expiring_30" : null;
  return null;
};

/**
 * Sends each Inbound Trigger token's expiry reminders as they fall due. Run
 * from the scheduler, under its lock. Each reminder is claimed on the row
 * before it is sent, so a sweep that runs twice, or a peer, never repeats one,
 * and deleting the Notification never brings it back; one that could not be
 * posted is handed back and sent by the next sweep. Each Trigger is handled
 * on its own, so one that fails does not hold back the rest.
 */
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
    // Read once, before the claim moves the row on: the hand-back restores it.
    const { tokenHash, tokenExpiresAt, tokenNotice: previous } = trigger;
    if (!tokenHash || !tokenExpiresAt) continue;
    const due = dueReminder(
      { tokenCreatedAt: trigger.tokenCreatedAt, tokenExpiresAt },
      now,
    );
    if (!due || tokenNoticeSent(previous, due)) continue;
    try {
      if (!(await claimNotice(trigger.id, tokenHash, previous, due))) continue;
      const sent = await notifyOwner(
        {
          organizationId: row.workspace.organizationId,
          workspaceId: row.workspace.id,
          trigger,
        },
        "Inbound trigger token expires soon",
        `The token for the inbound trigger "${trigger.name}" expires on ${formatDate(tokenExpiresAt)}. Regenerate it on the trigger's page and update the system that calls it; calls with the current token are refused once it expires.`,
      );
      if (!sent) {
        await releaseNotice(trigger.id, tokenHash, due, previous);
      }
    } catch (error) {
      logger.error(
        {
          triggerId: trigger.id,
          error: errorMessage(error),
        },
        "Failed to send an inbound trigger token reminder",
      );
    }
  }
};

// ----------------------------------------------------------------- org admin

export type OrgInboundTrigger = {
  id: string;
  name: string;
  enabled: boolean;
  workspaceId: string;
  workspaceName: string;
  ownerId: string;
  ownerName: string;
  createdAt: Date;
  tokenStatus: InboundTokenStatus;
  tokenCreatedAt: Date | null;
  tokenExpiresAt: Date | null;
  lastUsedAt: Date | null;
  lastRejectedAt: Date | null;
};

/**
 * Every Inbound Trigger in the Organization, for its Org Admins: where it is,
 * whose it is, and how its token stands. Never the token or its hash.
 */
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
      tokenStatus: inboundTokenStatus(trigger, now),
      tokenCreatedAt: trigger.tokenCreatedAt,
      tokenExpiresAt: trigger.tokenExpiresAt,
      lastUsedAt: trigger.lastUsedAt,
      lastRejectedAt: trigger.lastRejectedAt,
    }))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
};

const TOKEN_REPLACED_MESSAGE =
  "The token was replaced since you loaded the list. Refresh it and revoke the new one if it should stop too.";

/**
 * Revokes an Inbound Trigger's token on an Org Admin's behalf — the one thing
 * an Admin does inside another person's Workspace. The token stops working at
 * once and the Owner is told; regenerating stays theirs. `false` when no
 * Inbound Trigger by that id is in the Organization. Revoking a Trigger with
 * no token is a no-op that notifies nobody.
 *
 * `seenTokenCreatedAt` is when the token the Admin was looking at was issued.
 * A token issued at any other time is one they never judged, so the revoke is
 * refused rather than wiping it.
 */
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

  // Revokes the token the Admin was looking at, not whichever is current: an
  // Owner who regenerated since the list loaded issued a token nobody has
  // judged, and wiping it would hand them one that is dead on arrival.
  if (tokenCreatedAt?.getTime() !== seenTokenCreatedAt.getTime()) {
    throw new ConflictError(TOKEN_REPLACED_MESSAGE);
  }
  // The same holds for a regenerate landing between the read above and this
  // write, so the write is conditional on the hash just read.
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

  await notifyOwner(
    {
      organizationId: orgId,
      workspaceId: row.workspace.id,
      trigger: row.trigger,
    },
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
  resourceWorkspaceIds: async (orgId: string) =>
    (
      await db
        .select({ workspaceId: triggerTable.workspaceId })
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
    ).map((row) => row.workspaceId),
  changedMessage: "Inbound trigger access changed by an Org Admin",
} as const;

const toInboundAccess = ({
  gate,
  workspaces,
}: GateAccess): InboundTriggerAccess => ({
  gate,
  workspaces: workspaces.map(({ count, ...workspace }) => ({
    ...workspace,
    inboundTriggerCount: count,
  })),
});

/**
 * Who may take Inbound Trigger calls, for the Org Admin's Inbound Triggers
 * screen: the Organization gate, and every Workspace with its own switch and
 * how many Inbound Triggers it holds.
 */
export const getInboundTriggerAccess = async (
  orgId: string,
): Promise<InboundTriggerAccess> =>
  toInboundAccess(await getGateAccess(INBOUND_GATE, orgId));

/** Saves the Inbound Trigger gate; see {@link setGateAccess}. */
export const setInboundTriggerAccess = async (
  orgId: string,
  update: InboundTriggerAccessUpdate,
  actorUserId: string,
): Promise<InboundTriggerAccess> =>
  toInboundAccess(
    await setGateAccess(INBOUND_GATE, orgId, update, actorUserId),
  );
