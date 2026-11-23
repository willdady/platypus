export function renderSecurityGuardrails(text?: string | null): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  return `## Security and trust\n\n${trimmed}`;
}
