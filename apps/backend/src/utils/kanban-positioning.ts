export type CardRow = { id: string; position: number };

export function calculateCardPosition(
  otherCards: CardRow[],
  afterCardId: string | null,
): { position: number; needsRebalance: boolean; afterIndex: number } {
  let position: number;
  let afterIndex = -1;

  if (afterCardId === null) {
    position = otherCards.length === 0 ? 1.0 : otherCards[0].position / 2;
  } else {
    afterIndex = otherCards.findIndex((card) => card.id === afterCardId);
    if (afterIndex === -1) {
      throw new Error("afterCardId not found in column");
    }
    if (afterIndex === otherCards.length - 1) {
      position = otherCards[afterIndex].position + 1.0;
    } else {
      position =
        (otherCards[afterIndex].position +
          otherCards[afterIndex + 1].position) /
        2;
    }
  }

  const needsRebalance =
    afterCardId !== null &&
    afterIndex < otherCards.length - 1 &&
    afterIndex >= 0 &&
    otherCards[afterIndex + 1].position - otherCards[afterIndex].position <
      0.001;

  return { position, needsRebalance, afterIndex };
}
