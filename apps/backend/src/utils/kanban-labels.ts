/** A card as far as labels are concerned: its ID and the labels it holds. */
export type CardLabelRow = { id: string; labelIds: string[] };

/**
 * Keeps only the submitted label IDs that exist on the board, in the submitted
 * order. Board labels live in an array on the board record, so a card can hold
 * an ID for a label that has since been deleted; dropping those keeps a save
 * from failing over a reference the user cannot even see.
 */
export function filterKnownLabelIds(
  submitted: string[],
  known: string[],
): string[] {
  const knownIds = new Set(known);
  return submitted.filter((id) => knownIds.has(id));
}

/**
 * Given the cards on a board and the board's current label IDs, returns the
 * cards that reference a label the board no longer has, each with its pruned
 * label list. Cards that are already clean are left out so callers only write
 * the rows that change. This only ever removes IDs.
 */
export function pruneCardLabelIds(
  cards: CardLabelRow[],
  known: string[],
): CardLabelRow[] {
  const pruned: CardLabelRow[] = [];
  for (const card of cards) {
    const kept = filterKnownLabelIds(card.labelIds, known);
    if (kept.length !== card.labelIds.length) {
      pruned.push({ id: card.id, labelIds: kept });
    }
  }
  return pruned;
}
