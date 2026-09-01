import type { CachedInputTokens } from "@platypus/schemas";

/**
 * The cached-input breakdown copy shared by the two places a User reads one —
 * the Chat response-metrics panel and a Trigger run's cache tooltip (issue
 * #734). The copy is the shared half; each caller formats through its own
 * token formatter and wraps the lines in its own markup, but a wording change
 * now lives in one place (issue #745).
 *
 * Takes the pair as `CachedInputTokens`, which is how every caller already
 * holds it — on a `tokenUsage` object or a trigger run's `stats`.
 */
export function cachedTokenBreakdown(
  tokens: CachedInputTokens,
  format: (n: number) => string,
): string[] {
  const lines: string[] = [];
  if (tokens.cacheReadTokens !== undefined) {
    lines.push(`of which ${format(tokens.cacheReadTokens)} read from cache`);
  }
  if (tokens.cacheWriteTokens !== undefined) {
    lines.push(`of which ${format(tokens.cacheWriteTokens)} written to cache`);
  }
  return lines;
}
