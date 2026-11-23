export type CardLabelRow = { id: string; labelIds: string[] };

export function filterKnownLabelIds(
  submitted: string[],
  known: string[],
): string[] {
  const knownIds = new Set(known);
  return submitted.filter((id) => knownIds.has(id));
}

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
