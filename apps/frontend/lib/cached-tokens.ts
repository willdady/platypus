import type { CachedInputTokens } from "@platypus/schemas";

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
