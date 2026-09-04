import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The chain of Agents acting right now, some root Agent first and each of its
 * delegates after it, at any delegation depth. An empty chain means nothing
 * Agent-driven is running — the write is human- or user-originated, or a
 * direct (no-Agent) turn.
 *
 * The chain is *not* the `Principal` in `scope.ts`, though the two sit
 * adjacent: a `Principal` names the User or Trigger that owns a run, never the
 * Agents doing the work, and carries ids the plugin boundary deliberately
 * withholds. Causation is the one thing an Event Trigger's loop guard needs —
 * "did one of my owner's Agents cause this?" — and it is intentionally ambient
 * (ADR-0022): read by the dispatcher, never passed by the writer.
 */
export type AgentChain = readonly string[];

const chainStorage = new AsyncLocalStorage<AgentChain>();

/**
 * The Agent chain ambient to the current execution, or an empty chain when none
 * has been established (a human HTTP write, or a direct turn with no Agent).
 */
export const currentCausingAgents = (): AgentChain =>
  chainStorage.getStore() ?? [];

/**
 * Runs `fn` with `chain` established as the ambient causation context.
 *
 * Deliberately synchronous in signature: it wraps a Drive's model-loop setup,
 * and the SDK's streamed/generating call keeps the async context of that setup
 * alive through the tool executions it drives, so a later tool write still
 * reads the same chain. A zero-length chain is a no-op — there is nothing to
 * establish, and running without a store is exactly how an Agentless turn and
 * a human write both read as uncaused.
 */
export function withCausation<T>(chain: AgentChain, fn: () => T): T {
  if (chain.length === 0) return fn();
  return chainStorage.run(chain, fn);
}

/**
 * Runs `fn` with a single top-level Agent's id established as the ambient
 * causation chain. The one convenience most Drives need: when there is no
 * Agent (a direct turn, or a run without one), nothing is established and `fn`
 * runs uncaused.
 */
export function withAgentCausation<T>(
  agentId: string | undefined,
  fn: () => T,
): T {
  return agentId ? withCausation([agentId], fn) : fn();
}

/**
 * Runs `fn` with a delegate's Agent id appended to the ambient chain, for the
 * duration of the delegate's Drive. A delegate called outside any parent
 * causation (unreachable in practice, defended anyway) establishes a chain of
 * its own.
 */
export function withChildCausation<T>(agentId: string, fn: () => T): T {
  const parent = chainStorage.getStore();
  const child: AgentChain = parent ? [...parent, agentId] : [agentId];
  return chainStorage.run(child, fn);
}

/**
 * The Trigger whose run is driving the current execution, if any.
 *
 * A second ambient dimension alongside the Agent chain, and deliberately its
 * own store: the chain is established per-Agent deep inside a Drive, while the
 * originating Trigger is established once around a whole Trigger run, and
 * neither should have to carry the other's value through.
 *
 * It exists for the record — a dispatch log line that names which Trigger's
 * work produced the event (#812) — not for the self-actor guard, which still
 * compares Agent ids (#669).
 */
const originatingTriggerStorage = new AsyncLocalStorage<string>();

/**
 * The id of the Trigger whose run caused the current work, or `undefined` when
 * nothing Trigger-driven is running (a human write, or an interactive Chat).
 */
export const currentOriginatingTrigger = (): string | undefined =>
  originatingTriggerStorage.getStore();

/**
 * Runs `fn` with `triggerId` established as the ambient originating Trigger.
 * Same shape as {@link withCausation}: synchronous in signature, wrapping the
 * run's async call so everything the run goes on to do reads the same id. No
 * Trigger is a no-op, exactly as an Agentless turn reads as uncaused.
 */
export function withOriginatingTrigger<T>(
  triggerId: string | undefined,
  fn: () => T,
): T {
  return triggerId ? originatingTriggerStorage.run(triggerId, fn) : fn();
}
