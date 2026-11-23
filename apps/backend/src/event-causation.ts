import { AsyncLocalStorage } from "node:async_hooks";

export type AgentChain = readonly string[];

const chainStorage = new AsyncLocalStorage<AgentChain>();

export const currentCausingAgents = (): AgentChain =>
  chainStorage.getStore() ?? [];

export function withCausation<T>(chain: AgentChain, fn: () => T): T {
  if (chain.length === 0) return fn();
  return chainStorage.run(chain, fn);
}

export function withAgentCausation<T>(
  agentId: string | undefined,
  fn: () => T,
): T {
  return agentId ? withCausation([agentId], fn) : fn();
}

export function withChildCausation<T>(agentId: string, fn: () => T): T {
  const parent = chainStorage.getStore();
  const child: AgentChain = parent ? [...parent, agentId] : [agentId];
  return chainStorage.run(child, fn);
}

const originatingTriggerStorage = new AsyncLocalStorage<string>();

export const currentOriginatingTrigger = (): string | undefined =>
  originatingTriggerStorage.getStore();

export function withOriginatingTrigger<T>(
  triggerId: string | undefined,
  fn: () => T,
): T {
  return triggerId ? originatingTriggerStorage.run(triggerId, fn) : fn();
}

export type RunSource =
  | { kind: "chat"; chatId: string }
  | { kind: "triggerRun"; triggerRunId: string };

const runSourceStorage = new AsyncLocalStorage<RunSource>();

export const currentRunSource = (): RunSource | undefined =>
  runSourceStorage.getStore();

export function withRunSource<T>(source: RunSource, fn: () => T): T {
  return runSourceStorage.run(source, fn);
}
