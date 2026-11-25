export function splitPinned<T extends { isPinned?: boolean }>(
  agents: readonly T[],
): { pinned: T[]; unpinned: T[] } {
  return {
    pinned: agents.filter((agent) => agent.isPinned),
    unpinned: agents.filter((agent) => !agent.isPinned),
  };
}
