/**
 * Shared renderer for a provider's free-text security directives.
 *
 * Lives in its own leaf module (no heavy imports) so both the top-level system
 * prompt (`system-prompt.ts`) and the sub-agent path (`tools/sub-agent.ts`,
 * which never calls `renderSystemPrompt`) produce IDENTICAL wording without a
 * circular import between those two modules.
 */

/**
 * Wraps a provider's free-text security directives in a `## Security and trust`
 * block. Returns null for empty/whitespace/nullish input so callers can skip
 * the block entirely.
 */
export function renderSecurityGuardrails(text?: string | null): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  return `## Security and trust\n\n${trimmed}`;
}
