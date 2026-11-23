import { webhookEventChangedFields } from "@platypus/schemas";
import { logger } from "../logger.ts";
import type { EventContext } from "./trigger-firing.ts";
import type { trigger as triggerTable } from "../db/schema.ts";

type Trigger = typeof triggerTable.$inferSelect;

const pendingTriggers = new Map<
  string,
  {
    timer: ReturnType<typeof setTimeout>;
    trigger: Trigger;
    eventContext: EventContext;
    eventsFolded: number;
  }
>();

const DEBOUNCE_MS = 5_000;

const mergedEventContext = (
  pending: EventContext | undefined,
  incoming: EventContext,
): EventContext => {
  if (incoming.payload.event !== "card.updated") return incoming;
  const pendingFields = pending && webhookEventChangedFields(pending.payload);
  if (!pendingFields) return incoming;

  return {
    ...incoming,
    payload: {
      event: "card.updated",
      data: {
        ...incoming.payload.data,
        changedFields: [
          ...new Set([
            ...pendingFields,
            ...incoming.payload.data.changedFields,
          ]),
        ],
      },
    },
  };
};

export function debounceTriggerExecution(
  key: string,
  trigger: Trigger,
  eventContext: EventContext,
  executeFn: (trigger: Trigger, eventContext: EventContext) => Promise<void>,
): boolean {
  const existing = pendingTriggers.get(key);
  if (existing) {
    clearTimeout(existing.timer);
  }

  const mergedContext = mergedEventContext(
    existing?.eventContext,
    eventContext,
  );
  const eventsFolded = (existing?.eventsFolded ?? 0) + 1;

  if (existing) {
    logger.info(
      { debounceKey: key, triggerId: trigger.id, eventsFolded },
      "Event trigger burst coalesced",
    );
  }

  const timer = setTimeout(() => {
    pendingTriggers.delete(key);
    void executeFn(trigger, mergedContext);
  }, DEBOUNCE_MS);

  pendingTriggers.set(key, {
    timer,
    trigger,
    eventContext: mergedContext,
    eventsFolded,
  });

  return existing !== undefined;
}

export function clearPendingTriggers(): void {
  for (const { timer } of pendingTriggers.values()) {
    clearTimeout(timer);
  }
  pendingTriggers.clear();
}
