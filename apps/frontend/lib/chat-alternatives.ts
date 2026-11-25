import type { Chat } from "@platypus/schemas";

export type AlternativePosition = {
  index: number;
  count: number;
  previousId: string | null;
  nextId: string | null;
};

export function alternativePositions(
  tree: NonNullable<Chat["tree"]> | undefined,
  pathIds: readonly string[],
): Map<string, AlternativePosition> {
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
}
