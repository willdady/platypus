import type { Tool } from "ai";

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
 * Lives in its own module because both the parent turn's tool wrapper and the
 * sub-agent tool builder need it, and those two import each other.
 */
export const normalizeToolResult = (value: unknown): unknown => {
  const json = JSON.stringify(value);
  if (json === undefined) return value;
  return JSON.parse(json);
};

/**
 * Apply {@link normalizeToolResult} to every tool in a map.
 *
 * The parent turn gets this via `wrapToolsWithBump`, which also does heartbeat
 * bookkeeping. A sub-agent's own tools never pass through that wrapper — they go
 * from `loadTools` straight into its `ToolLoopAgent` — so without this they
 * reach the sub-agent's next step raw, and a Drizzle `Date` fails the same
 * validation one level down. The symptom is unrecognisable as #321 from the
 * outside: the sub-agent dies mid-stream and the parent sees a truncated answer.
 *
 * The async-iterable path is left alone, matching the parent wrapper: those
 * yields are streamed UI parts, not the value fed to the model.
 */
export const withNormalizedResults = (
  tools: Record<string, Tool>,
): Record<string, Tool> => {
  const wrapped: Record<string, Tool> = {};
  for (const [name, t] of Object.entries(tools)) {
    const execute = (t as { execute?: unknown }).execute;
    if (typeof execute !== "function") {
      wrapped[name] = t;
      continue;
    }
    const runExecute = execute as (args: unknown, options: unknown) => unknown;
    wrapped[name] = {
      ...t,
      execute: (args: unknown, options: unknown) => {
        const result = runExecute.call(t, args, options);
        if (
          result != null &&
          typeof (result as { then?: unknown }).then === "function"
        ) {
          return (result as Promise<unknown>).then(normalizeToolResult);
        }
        if (
          result != null &&
          typeof (result as Record<symbol, unknown>)[Symbol.asyncIterator] ===
            "function"
        ) {
          return result;
        }
        return normalizeToolResult(result);
      },
    };
  }
  return wrapped;
};
