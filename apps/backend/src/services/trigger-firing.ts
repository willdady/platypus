import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { db } from "../index.ts";
import {
  trigger as triggerTable,
  user as userTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import { logger } from "../logger.ts";
import { agentRunner } from "../runs/agent-runner.ts";
import { TriggerSink } from "../runs/sinks/trigger-sink.ts";
import { triggerTimeouts } from "../runs/trigger-timeouts.ts";
import { workspaceScopeForTrigger } from "../scope.ts";
import {
  currentCausingAgents,
  currentOriginatingTrigger,
  withOriginatingTrigger,
} from "../event-causation.ts";
import {
  retainTriggerRuns,
  shouldSuppressTriggerRun,
  suppressTriggerRun,
} from "./trigger-breaker.ts";
import {
  narrowTriggerConfig,
  nextCronRunAt,
  type TriggerRow,
  type TypedTriggerConfig,
} from "./trigger.ts";
import type { RunInput } from "../runs/types.ts";
import type { PlatypusUIMessage } from "../types.ts";
import type { WebhookEventPayload } from "@platypus/schemas";

/**
 * Trigger firing: the one place a Trigger row becomes a run.
 *
 * A firing is the whole of what happens when a Trigger goes off — the
 * run-rate breaker, the Agent run under the Trigger timeouts, and the
 * bookkeeping every exit owes the row: `lastRunAt`, the next schedule (or a
 * one-off's self-disable), and run retention. The scheduler and event dispatch
 * decide *when* a Trigger fires; neither knows what firing involves.
 *
 * The bookkeeping used to live beside each caller, on the line after the run,
 * so a run that threw skipped it: a failing Trigger's history grew without
 * bound, and an Event Trigger's `lastRunAt` never moved. It also wrote back the
 * snapshot the run was fired from, which re-enabled a Trigger its Workspace
 * Owner switched off mid-run. Here it runs on every exit, against the row as
 * it is once the run ends.
 */

export type EventContext = {
  /** The event that fired this run, carried with its declared payload. */
  payload: WebhookEventPayload;
  /**
   * The single entity the event named, when it named one. Persisted on the run
   * row so the run-rate breaker can count per entity; absent for events that
   * name a set instead (bulk `notification.read`), which the breaker exempts.
   */
  entityId?: string;
};

/** Why a Trigger is firing: its schedule came due, or an event matched it. */
export type FiringCause = { kind: "cron" } | ({ kind: "event" } & EventContext);

/**
 * How a firing ended. `failed` covers a run that threw — a model error, a
 * timeout, a missing Workspace — not one the Drive finished as failed and
 * returned from (the no-progress stop), which reads as `ran`; the run row
 * carries the real status either way.
 */
export type FiringOutcome = "ran" | "failed" | "suppressed";

/**
 * Fires `trigger` for `cause`. Resolves once the firing and its bookkeeping are
 * done, and never rejects: a run failure is logged here, since there is no
 * HTTP caller to map it for (ADR-0010).
 *
 * `trigger` is the snapshot the caller selected; the run is built from it. The
 * bookkeeping re-reads the row instead, because the Workspace Owner may have
 * edited, disabled or deleted it while the run was in flight.
 */
export const fireTrigger = async (
  trigger: TriggerRow,
  cause: FiringCause,
): Promise<FiringOutcome> => {
  const eventContext: EventContext | undefined =
    cause.kind === "event"
      ? { payload: cause.payload, entityId: cause.entityId }
      : undefined;

  // The breaker is checked when the run would start, not when the event
  // arrived: the debounce has then folded any burst into one firing, so a
  // burst cannot manufacture suppressed rows, and the count includes runs that
  // started during the window. A suppressed firing is not a run, so it stamps
  // no `lastRunAt`; `suppressTriggerRun` applies retention itself.
  if (eventContext?.entityId) {
    try {
      if (await shouldSuppressTriggerRun(trigger.id, eventContext.entityId)) {
        await suppressTriggerRun({
          triggerId: trigger.id,
          maxRunsToKeep: trigger.maxRunsToKeep,
          entityId: eventContext.entityId,
          eventType: eventContext.payload.event,
          eventData: eventContext.payload.data,
        });
        return "suppressed";
      }
    } catch (error) {
      logger.error(
        { triggerId: trigger.id, error: errorMessage(error) },
        "Trigger run-rate breaker failed; firing dropped",
      );
      return "failed";
    }
  }

  let outcome: FiringOutcome = "ran";
  try {
    await runTrigger(trigger, eventContext);
  } catch (error) {
    outcome = "failed";
    logger.error(
      {
        triggerId: trigger.id,
        type: trigger.type,
        eventType: eventContext?.payload.event,
        error: errorMessage(error),
      },
      "Trigger run failed",
    );
  }

  await recordFiring(trigger.id);
  return outcome;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Runs the Trigger's Agent against its instruction. For event Triggers, the
 * event is prepended to the instruction. Throws when the run does.
 */
const runTrigger = async (
  trigger: TriggerRow,
  eventContext: EventContext | undefined,
): Promise<void> => {
  const { id, workspaceId, agentId, instruction } = trigger;
  const runId = nanoid();

  // Workspace is fetched up-front to derive the run scope, joined to its
  // owner because the scope names the user the run acts on behalf of and that
  // name lives on the user row. The join is inner: `ownerId` is a non-null FK
  // under cascade delete, so a Workspace that loads always has an owner. The
  // runner re-reads the Workspace for system-prompt context — at trigger
  // volumes the extra round-trip is acceptable.
  const [workspace] = await db
    .select({
      organizationId: workspaceTable.organizationId,
      ownerId: workspaceTable.ownerId,
      ownerName: userTable.name,
    })
    .from(workspaceTable)
    .innerJoin(userTable, eq(userTable.id, workspaceTable.ownerId))
    .where(eq(workspaceTable.id, workspaceId))
    .limit(1);

  if (!workspace) {
    // No run row inserted yet — the firing still owes the Trigger its
    // bookkeeping, which `fireTrigger` applies on the way out.
    throw new Error(`Workspace '${workspaceId}' not found for trigger '${id}'`);
  }

  const scope = workspaceScopeForTrigger({
    triggerId: id,
    workspaceId,
    organizationId: workspace.organizationId,
    ownerUserId: workspace.ownerId,
    ownerName: workspace.ownerName,
  });

  const effectiveInstruction = eventContext
    ? `Event: ${eventContext.payload.event}\nEvent Data:\n${JSON.stringify(eventContext.payload.data, null, 2)}\n---\n${instruction}`
    : instruction;

  const messages: PlatypusUIMessage[] = [
    {
      id: nanoid(),
      role: "user",
      parts: [{ type: "text", text: effectiveInstruction }],
    },
  ];

  const input: RunInput = {
    runId,
    request: { agentId, search: trigger.search ?? undefined },
    messages,
    // A headless run carries no Chat identity and so no pin: when it composes
    // Memories at all it renders the current block, anchored to the moment this
    // firing resolved (ADR-0020). Stamped once here rather than read inside turn
    // preparation, so the reference date is an input the run can be replayed
    // against.
    memoriesReferenceDate: new Date(),
    // Off unless this Trigger opts in (#645), which is what keeps a firing's
    // prompt from drifting with interactive-chat activity unrelated to it.
    includeMemories: trigger.includeMemories,
  };

  const sink = new TriggerSink({
    triggerId: id,
    entityId: eventContext?.entityId,
    eventType: eventContext?.payload.event,
    eventData: eventContext?.payload.data,
  });

  // What caused this firing, read before the run establishes itself as the
  // next cause. On a cron both are empty; on an event Trigger they are the
  // ambient context of the write that dispatched it, which is the one thing a
  // Trigger loop leaves no other record of (#812).
  //
  // Identifiers only. The instruction is deliberately absent: on an event
  // Trigger it opens with the serialised event payload, so even a short prefix
  // put Card titles and body text on this line (#812).
  logger.info(
    {
      triggerId: id,
      runId,
      agentId,
      type: trigger.type,
      eventType: eventContext?.payload.event,
      causingAgents: currentCausingAgents(),
      originatingTriggerId: currentOriginatingTrigger(),
    },
    "Starting trigger execution",
  );

  // Everything this run writes is caused by this Trigger, at any delegation
  // depth — the ambient context a later dispatch reads back to name where the
  // event came from (ADR-0022). The Agent chain is established deeper, by the
  // Drive.
  await withOriginatingTrigger(id, () =>
    agentRunner.generate({
      scope,
      input,
      sink,
      options: {
        frontendUrl: process.env.FRONTEND_URL,
        timeouts: triggerTimeouts(),
      },
    }),
  );
};

/** The row's narrowed config, or `null` — logged — when it is malformed. */
const narrowOrNull = (row: TriggerRow): TypedTriggerConfig | null => {
  try {
    return narrowTriggerConfig(row);
  } catch (error) {
    logger.error(
      { triggerId: row.id, error: errorMessage(error) },
      "Trigger row is malformed; its schedule was not updated",
    );
    return null;
  }
};

/**
 * What every firing that got as far as a run owes its Trigger, whatever the
 * run's outcome: `lastRunAt` at completion, the next schedule, and retention.
 *
 * Reads the row as it is now rather than the snapshot the run was fired from,
 * and never writes `enabled: true`: a Workspace Owner who disables or edits a
 * Trigger mid-run keeps what they set. A row deleted mid-run is simply gone.
 * A failure here is logged and swallowed — the run already happened.
 */
const recordFiring = async (triggerId: string): Promise<void> => {
  try {
    const [current] = await db
      .select()
      .from(triggerTable)
      .where(eq(triggerTable.id, triggerId))
      .limit(1);
    if (!current) {
      logger.info({ triggerId }, "Trigger was deleted during its run");
      return;
    }

    const now = new Date();
    const typed = narrowOrNull(current);
    const schedule: Partial<TriggerRow> = {};
    if (!typed) {
      // A malformed row gets no schedule written, but still its `lastRunAt`
      // and retention: a run happened, and its history must stay bounded.
    } else if (typed.type === "cron" && typed.config.isOneOff) {
      // A one-off has had its one run, whether or not it succeeded — retrying
      // a failed one every tick would be an unbounded loop.
      schedule.enabled = false;
      schedule.nextRunAt = null;
    } else if (typed.type === "cron") {
      schedule.nextRunAt = nextCronRunAt(typed.config);
      if (!schedule.nextRunAt) {
        logger.error(
          { triggerId, cronExpression: typed.config.cronExpression },
          "Failed to compute next run for trigger",
        );
      }
    }

    await db
      .update(triggerTable)
      .set({ lastRunAt: now, updatedAt: now, ...schedule })
      .where(eq(triggerTable.id, triggerId));

    // The newest maxRunsToKeep rows, plus everything inside the run-rate
    // breaker's window so its count is never pruned out from under it.
    await retainTriggerRuns(triggerId, current.maxRunsToKeep);

    logger.info(
      {
        triggerId,
        type: current.type,
        enabled: schedule.enabled ?? current.enabled,
        nextRunAt: schedule.nextRunAt?.toISOString(),
      },
      "Updated trigger after run",
    );
  } catch (error) {
    logger.error(
      { triggerId, error: errorMessage(error) },
      "Failed to update trigger after run",
    );
  }
};
