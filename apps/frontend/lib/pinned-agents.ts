/**
 * Splits a Workspace's agents into the ones its Owner pinned and the rest,
 * keeping each side in the order given. Every surface that lists a
 * Workspace's agents shows the pinned ones in their own group above the rest,
 * read from the `isPinned` the agents list already carries.
 */
export function splitPinned<T extends { isPinned?: boolean }>(
  agents: readonly T[],
): { pinned: T[]; unpinned: T[] } {
  return {
    pinned: agents.filter((agent) => agent.isPinned),
    unpinned: agents.filter((agent) => !agent.isPinned),
  };
}
