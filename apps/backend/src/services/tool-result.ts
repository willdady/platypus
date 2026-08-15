/**
 * Coerce a tool result to plain JSON (issue #321).
 *
 * AI SDK v7 feeds each tool result into the next model step, where
 * `standardizePrompt()` validates tool-result parts against a strict JSON-value
 * schema. Non-JSON values — most commonly a raw `Date` from a Drizzle/`pg` query
 * row (a `createdAt`/`updatedAt` timestamp) — fail that validation and crash the
 * turn with `InvalidPromptError`. A JSON round-trip converts `Date` → ISO string
 * and drops `undefined`.
 *
 * Deliberate trade-off: a plain round-trip throws on `BigInt`. Tools are not
 * expected to return `BigInt`, so we accept that rather than complicate the
 * normalizer. A top-level `undefined`/function return (whose `JSON.stringify` is
 * `undefined`) is passed through unchanged instead of crashing `JSON.parse`.
 *
 * Lives in its own module because the tool-activity wrapper that applies it is
 * shared between a parent turn and a delegated sub-agent run, and this module
 * must stay free of both.
 */
export const normalizeToolResult = (value: unknown): unknown => {
  const json = JSON.stringify(value);
  if (json === undefined) return value;
  return JSON.parse(json);
};
