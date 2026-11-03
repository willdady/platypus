/**
 * How a token figure reads wherever two counts share one display idiom: grouped
 * with the reader's locale's separators (`12,345`). Shared by the
 * response-metrics panel's **Token usage** and a **Transcript summary**'s
 * recorded cost, so those two never drift into different formats (issue #1733).
 * The compact context-meter figures use their own formatter.
 */
export function formatTokenCount(n: number): string {
  return n.toLocaleString();
}
