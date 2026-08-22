import type { EventContext } from "./trigger-execution.ts";
import type { trigger as triggerTable } from "../db/schema.ts";

type Trigger = typeof triggerTable.$inferSelect;

const pendingTriggers = new Map<
  string,
  {
    timer: ReturnType<typeof setTimeout>;
    trigger: Trigger;
    eventContext: EventContext;
  }
>();

const DEBOUNCE_MS = 5_000;

/**
 * The event context a coalesced replacement delivers: the incoming context,
 * except `changedFields` — when both the incoming and the pending context
 * carry one — is the union of the two, so a trigger that eventually runs
 * sees every field changed across the coalesced window, not just the last
 * event's (see #622).
 */
/** The `changedFields` an event's data carries, or `undefined` if it has none. */
const changedFieldsOf = (eventData: unknown): string[] | undefined => {
  const fields = (eventData as { changedFields?: unknown } | undefined)
    ?.changedFields;
  return Array.isArray(fields) && fields.every((f) => typeof f === "string")
    ? fields
    : undefined;
};

const mergedEventContext = (
  pending: EventContext | undefined,
  incoming: EventContext,
): EventContext => {
  const pendingFields = changedFieldsOf(pending?.eventData);
  const incomingFields = changedFieldsOf(incoming.eventData);
  if (!pendingFields || !incomingFields) return incoming;

  return {
    ...incoming,
    eventData: {
      ...(incoming.eventData as Record<string, unknown>),
      changedFields: [...new Set([...pendingFields, ...incomingFields])],
    },
  };
};

export function debounceTriggerExecution(
  key: string,
  trigger: Trigger,
  eventContext: EventContext,
  executeFn: (trigger: Trigger, eventContext: EventContext) => Promise<void>,
): void {
  const existing = pendingTriggers.get(key);
  if (existing) {
    clearTimeout(existing.timer);
  }

  const mergedContext = mergedEventContext(
    existing?.eventContext,
    eventContext,
  );

  const timer = setTimeout(() => {
    pendingTriggers.delete(key);
    void executeFn(trigger, mergedContext);
  }, DEBOUNCE_MS);

  pendingTriggers.set(key, { timer, trigger, eventContext: mergedContext });
}

export function clearPendingTriggers(): void {
  for (const { timer } of pendingTriggers.values()) {
    clearTimeout(timer);
  }
  pendingTriggers.clear();
}
