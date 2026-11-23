import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { db } from "../index.ts";
import {
  organizationMember,
  trigger as triggerTable,
  user as userTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import { logger } from "../logger.ts";
import { errorMessage } from "../utils/error-message.ts";
import { agentRunner } from "../runs/agent-runner.ts";
import { frontendBaseUrl } from "../base-urls.ts";
import { TriggerSink } from "../runs/sinks/trigger-sink.ts";
import { ChatSink } from "../runs/sinks/chat-sink.ts";
import { compositeSink } from "../runs/sinks/composite-sink.ts";
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
  failUnstartedTriggerRun,
  suppressTriggerRun,
} from "./trigger-run-lifecycle.ts";
import { shouldSuppressTriggerRun } from "./trigger-breaker.ts";
import type { TriggerRow } from "./trigger.ts";
import type { RunInput } from "../runs/types.ts";
import type { PlatypusUIMessage } from "../types.ts";
import type {
  InboundTriggerInput,
  EventTriggerEventPayload,
} from "@platypus/schemas";

export type EventContext = {
  payload: EventTriggerEventPayload;
  entityId?: string;
};

export type InboundContext = {
  runId: string;
  inputs: Record<string, string>;
  declared: InboundTriggerInput[];
  entityId: string;
};

export type FiringCause =
  | { kind: "cron" }
  | ({ kind: "event" } & EventContext)
  | ({ kind: "inbound" } & InboundContext);

export type FiringOutcome = "ran" | "failed" | "suppressed";

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

  if (eventContext?.entityId) {
    try {
      if (await shouldSuppressTriggerRun(trigger.id, eventContext.entityId)) {
        await suppressTriggerRun({
          triggerId: trigger.id,
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
      await failUnstartedTriggerRun(inboundContext.runId, error);
    }
  }

  await recordFiring(trigger.id);
  return outcome;
};

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

const runChatTitle = (name: string, startedAt: Date): string =>
  `${name} · ${startedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`;

const runTrigger = async (
  trigger: TriggerRow,
  eventContext: EventContext | undefined,
  inboundContext: InboundContext | undefined,
): Promise<void> => {
  const { id, workspaceId, agentId, instruction } = trigger;
  const runId = inboundContext?.runId ?? nanoid();

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
    request: { agentId, search: trigger.search },
    messages,
    memoriesReferenceDate: new Date(),
    includeMemories: trigger.includeMemories,
    memoryTools: true,
  };

  const owner = { workspaceId, ownerId: workspace.ownerId };
  const runSink = inboundContext
    ? new TriggerSink({ triggerId: id, ...owner, adoptPendingRow: true })
    : new TriggerSink({
        triggerId: id,
        ...owner,
        entityId: eventContext?.entityId,
        eventType: eventContext?.payload.event,
        eventData: eventContext?.payload.data,
      });
  // why: run sink first; the Chat row references the run row
  const sink = compositeSink(
    runSink,
    new ChatSink({
      orgId: workspace.organizationId,
      ...owner,
      message: messages[0],
      parentId: null,
      newChat: {
        agentId,
        triggerRunId: runId,
        title: runChatTitle(trigger.name, new Date()),
      },
    }),
  );

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

  await withOriginatingTrigger(id, () =>
    withRunSource({ kind: "triggerRun", triggerRunId: runId }, () =>
      agentRunner.generate({
        scope,
        input,
        sink,
        options: {
          frontendUrl: frontendBaseUrl(),
          timeouts: triggerTimeouts(),
        },
      }),
    ),
  );
};

const recordFiring = async (triggerId: string): Promise<void> => {
  try {
    const [current] = await db
      .select({ id: triggerTable.id, type: triggerTable.type })
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

    logger.info({ triggerId, type: current.type }, "Updated trigger after run");
  } catch (error) {
    logger.error(
      { triggerId, error: errorMessage(error) },
      "Failed to update trigger after run",
    );
  }
};
