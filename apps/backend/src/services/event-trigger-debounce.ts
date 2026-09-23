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
    /** How many events this window has folded together, this one included. */
    eventsFolded: number;
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

/**
 * Schedules `executeFn` for the debounce window `key` names, restarting the
 * window if one is already open.
 *
 * Returns whether this event was folded into an open window rather than
 * opening one — the caller records that as the dispatch decision (#812), which
 * is the only way a coalesced burst is distinguishable after the fact from a
 * single event.
 */
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
    // Identifiers and a count only: `eventData` carries Card titles and bodies,
    // which are the Operator's users' content and never belong in a log line.
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
