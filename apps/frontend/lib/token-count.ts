/**
 * How every token count in the product reads: grouped with the reader's
 * locale's separators (`12,345`). Shared by the response-metrics panel's
 * **Token usage** and a **Transcript summary**'s recorded cost, so the two
 * figures never drift into different formats (issue #1733).
 */
export function formatTokenCount(n: number): string {
  return n.toLocaleString();
}
