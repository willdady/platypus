import { nanoid } from "nanoid";
import { and, eq } from "drizzle-orm";
import { db } from "../index.ts";
import {
  organizationMember,
  trigger as triggerTable,
  triggerRun as triggerRunTable,
  user as userTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import { logger } from "../logger.ts";
import { errorMessage } from "../utils/error-message.ts";
import { agentRunner } from "../runs/agent-runner.ts";
import { TriggerSink } from "../runs/sinks/trigger-sink.ts";
import { callerDataBlock } from "./caller-data.ts";
import {
  ownerMayAct,
  ownerMembershipJoin,
  ownerStandingColumns,
} from "./owner-membership.ts";
import { triggerTimeouts } from "../runs/trigger-timeouts.ts";
import { workspaceScopeForTrigger } from "../scope.ts";
import {
  currentCausingAgents,
  currentOriginatingTrigger,
  withOriginatingTrigger,
  withRunSource,
} from "../event-causation.ts";
import {
  retainTriggerRuns,
  shouldSuppressTriggerRun,
  suppressTriggerRun,
} from "./trigger-breaker.ts";
import {
  announceTriggerRunsEnded,
  endedTriggerRunColumns,
} from "./trigger-run-announce.ts";
import type { TriggerRow } from "./trigger.ts";
import type { RunInput } from "../runs/types.ts";
import type { PlatypusUIMessage } from "../types.ts";
import type {
  InboundTriggerInput,
  EventTriggerEventPayload,
} from "@platypus/schemas";

/**
 * Trigger firing: the one place a Trigger row becomes a run.
 *
 * A firing is the whole of what happens when a Trigger goes off — the
 * run-rate breaker, the Agent run under the Trigger timeouts, and the
 * bookkeeping every exit owes the row: `lastRunAt` and run retention. The
 * scheduler and event dispatch decide *when* a Trigger fires; neither knows
 * what firing involves.
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
  payload: EventTriggerEventPayload;
  /**
   * The single entity the event named, when it named one. Persisted on the run
   * row so the run-rate breaker can count per entity; absent for events that
   * name a set instead (bulk `notification.read`), which the breaker exempts.
   */
  entityId?: string;
};

/**
 * What an accepted Inbound Trigger call hands the firing (ADR-0030). The call
 * has already been through the breaker and dedup, and its run row written as
 * `pending` under `runId` — the id the caller was given.
 */
export type InboundContext = {
  runId: string;
  /** The call's validated inputs, by name: every value a string. */
  inputs: Record<string, string>;
  /** The declarations they were validated against, for their descriptions. */
  declared: InboundTriggerInput[];
  /** The record key's value, or the Trigger's own id when none is marked. */
  entityId: string;
};

/**
 * Why a Trigger is firing: its schedule came due, an event matched it, or an
 * external caller fired it.
 */
export type FiringCause =
  | { kind: "cron" }
  | ({ kind: "event" } & EventContext)
  | ({ kind: "inbound" } & InboundContext);

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
  const inboundContext: InboundContext | undefined =
    cause.kind === "inbound" ? cause : undefined;

  // The breaker is checked when the run would start, not when the event
  // arrived: the debounce has then folded any burst into one firing, so a
  // burst cannot manufacture suppressed rows, and the count includes runs that
  // started during the window. A suppressed firing is not a run, so it stamps
  // no `lastRunAt`; `suppressTriggerRun` applies retention itself. An inbound
  // firing was already counted when its call was accepted, since the call's
  // log line and response owe the verdict before the run starts.
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
    await runTrigger(trigger, eventContext, inboundContext);
  } catch (error) {
    outcome = "failed";
    logger.error(
      {
        triggerId: trigger.id,
        type: trigger.type,
        eventType: eventContext?.payload.event,
        runId: inboundContext?.runId,
        error: errorMessage(error),
      },
      "Trigger run failed",
    );
    if (inboundContext) {
      await failPendingRun(inboundContext.runId, error);
    }
  }

  await recordFiring(trigger.id);
  return outcome;
};

/**
 * Ends an inbound run whose firing threw before its Drive adopted the row, so
 * the run id its caller holds reaches a terminal status instead of reading
 * `pending` until the recovery sweep. A row the Drive already adopted is left
 * alone: its sink wrote the real outcome, and announced it.
 */
const failPendingRun = async (runId: string, error: unknown) => {
  try {
    const ended = await db
      .update(triggerRunTable)
      .set({
        status: "failed",
        errorMessage: errorMessage(error),
        completedAt: new Date(),
      })
      .where(
        and(
          eq(triggerRunTable.id, runId),
          eq(triggerRunTable.status, "pending"),
        ),
      )
      .returning(endedTriggerRunColumns);
    if (ended.length > 0) void announceTriggerRunsEnded(ended);
  } catch (updateError) {
    logger.error(
      { runId, error: errorMessage(updateError) },
      "Failed to mark a pending inbound trigger run as failed",
    );
  }
};

/**
 * The labelled block an inbound run's inputs arrive in, above the Instruction
 * — where an Event Trigger's payload goes. Each value is JSON-encoded, so a
 * multi-line value cannot pass itself off as the next input or as the
 * Instruction. No templating: the Instruction refers to inputs by name.
 */
export const composeInboundInputs = (
  inputs: Record<string, string>,
  declared: InboundTriggerInput[],
): string => {
  const lines = declared
    .filter((input) => Object.hasOwn(inputs, input.name))
    .map((input) => {
      const description = input.description
        ? ` (${input.description.replace(/\s+/g, " ").trim()})`
        : "";
      return `- ${input.name}${description}: ${JSON.stringify(inputs[input.name])}`;
    });
  return callerDataBlock(
    "Inbound call inputs",
    lines.length ? lines : ["(none)"],
  );
};

/**
 * Runs the Trigger's Agent against its instruction. For event Triggers, the
 * event is prepended to the instruction. Throws when the run does.
 */
const runTrigger = async (
  trigger: TriggerRow,
  eventContext: EventContext | undefined,
  inboundContext: InboundContext | undefined,
): Promise<void> => {
  const { id, workspaceId, agentId, instruction } = trigger;
  const runId = inboundContext?.runId ?? nanoid();

  // Workspace is fetched up-front to derive the run scope, joined to its
  // owner because the scope names the user the run acts on behalf of and that
  // name lives on the user row. The join is inner: `ownerId` is a non-null FK
  // under cascade delete, so a Workspace that loads always has an owner. The
  // runner re-reads the Workspace for system-prompt context — at trigger
  // volumes the extra round-trip is acceptable.
  //
  // The owner's Organization membership is joined too. Removing a member
  // disables their Triggers, but a firing already selected when that happens,
  // or any path that starts a run without consulting `enabled`, would still
  // run as a user who has left. Banning a user disables nothing, so their
  // Triggers keep being selected. Refuse both here (`ownerMayAct`): a super
  // admin acts in every Organization without a membership, but not banned.
  const [workspace] = await db
    .select({
      organizationId: workspaceTable.organizationId,
      ownerId: workspaceTable.ownerId,
      ownerName: userTable.name,
      ...ownerStandingColumns,
    })
    .from(workspaceTable)
    .innerJoin(userTable, eq(userTable.id, workspaceTable.ownerId))
    .leftJoin(organizationMember, ownerMembershipJoin())
    .where(eq(workspaceTable.id, workspaceId))
    .limit(1);

  // No run row inserted yet on either refusal — the firing still owes the
  // Trigger its bookkeeping, which `fireTrigger` applies on the way out.
  if (!workspace) {
    throw new Error(`Workspace '${workspaceId}' not found for trigger '${id}'`);
  }
  if (!ownerMayAct(workspace)) {
    throw new Error(
      `Owner of workspace '${workspaceId}' may no longer act in it (left its organization or banned); trigger '${id}' not run`,
    );
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
    : inboundContext
      ? `${composeInboundInputs(inboundContext.inputs, inboundContext.declared)}\n---\n${instruction}`
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

  const owner = { workspaceId, ownerId: workspace.ownerId };
  const sink = inboundContext
    ? new TriggerSink({ triggerId: id, ...owner, adoptPendingRow: true })
    : new TriggerSink({
        triggerId: id,
        ...owner,
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
  // Drive. The run itself is the source a Notification it posts records
  // (#1229).
  await withOriginatingTrigger(id, () =>
    withRunSource({ kind: "triggerRun", triggerRunId: runId }, () =>
      agentRunner.generate({
        scope,
        input,
        sink,
        options: {
          frontendUrl: process.env.FRONTEND_URL,
          timeouts: triggerTimeouts(),
        },
      }),
    ),
  );
};

/**
 * What every firing that got as far as a run owes its Trigger, whatever the
 * run's outcome: `lastRunAt` at completion, and retention. The schedule is not
 * written here: the scheduler's claim already wrote a cron Trigger's next run
 * (or disabled a one-off) before the run started.
 *
 * Reads the row as it is now rather than the snapshot the run was fired from:
 * a Workspace Owner who disables or edits a Trigger mid-run keeps what they
 * set. A row deleted mid-run is simply gone. A failure here is logged and
 * swallowed — the run already happened.
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
    await db
      .update(triggerTable)
      .set({ lastRunAt: now, updatedAt: now })
      .where(eq(triggerTable.id, triggerId));

    // The newest maxRunsToKeep rows, plus everything inside the run-rate
    // breaker's window so its count is never pruned out from under it.
    await retainTriggerRuns(triggerId, current.maxRunsToKeep);

    logger.info({ triggerId, type: current.type }, "Updated trigger after run");
  } catch (error) {
    logger.error(
      { triggerId, error: errorMessage(error) },
      "Failed to update trigger after run",
    );
  }
};
