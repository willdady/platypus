import type { Chat } from "@platypus/schemas";

/**
 * Where a message on the Active path sits among its Alternatives (ADR-0026):
 * the messages that follow the same one, or that all open the Chat.
 */
export type AlternativePosition = {
  /** Its place among them, oldest first, from 0. */
  index: number;
  count: number;
  /** The Alternatives either side of it. */
  previousId: string | null;
  nextId: string | null;
};

/**
 * The position of each message in `pathIds` that has Alternatives, worked out
 * from the Chat's `tree`. A message with none, or one the tree does not list
 * yet, has no entry.
 */
export const alternativePositions = (
  tree: NonNullable<Chat["tree"]> | undefined,
  pathIds: readonly string[],
): Map<string, AlternativePosition> => {
  const parentOf = new Map<string, string | null>();
  const alternativesUnder = new Map<string | null, string[]>();
  for (const { id, parentId } of tree ?? []) {
    parentOf.set(id, parentId);
    const alternatives = alternativesUnder.get(parentId);
    if (alternatives) alternatives.push(id);
    else alternativesUnder.set(parentId, [id]);
  }

  const positions = new Map<string, AlternativePosition>();
  for (const id of pathIds) {
    const parentId = parentOf.get(id);
    if (parentId === undefined) continue;
    const alternatives = alternativesUnder.get(parentId)!;
    if (alternatives.length < 2) continue;
    const index = alternatives.indexOf(id);
    positions.set(id, {
      index,
      count: alternatives.length,
      previousId: alternatives[index - 1] ?? null,
      nextId: alternatives[index + 1] ?? null,
    });
  }
  return positions;
};
