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
 * Lives in its own module because the loader seam that applies it is shared
 * between a parent turn and a delegated sub-agent run, and this module must stay
 * free of both.
 */
export const normalizeToolResult = (value: unknown): unknown => {
  const json = JSON.stringify(value);
  if (json === undefined) return value;
  return JSON.parse(json);
};

/**
 * Wrap every tool in a map so its result is normalized on the way back to the
 * model.
 *
 * Applied at the loader seam — `composeToolSet` for a Tool set, the MCP branch of
 * a Tool session — so that every tool a plugin or an MCP server contributes is
 * covered whether or not the turn happens to be observed. It used to ride on
 * `wrapToolsWithActivity`, which meant a correctness guarantee only held when an
 * optional `onActivity` callback was supplied.
 *
 * The tools core builds itself (search, `loadSkill`, the sub-agent delegates)
 * return core-owned JSON shapes and are deliberately not wrapped here.
 *
 * The async-iterable path is exempt for the same reason it always was: its yields
 * are streamed UI parts, not the value fed to the model.
 */
export const normalizeToolResults = (
  tools: Record<string, Tool>,
): Record<string, Tool> => {
  const normalized: Record<string, Tool> = {};
  for (const [name, t] of Object.entries(tools)) {
    const execute = (t as { execute?: unknown }).execute;
    if (typeof execute !== "function") {
      normalized[name] = t;
      continue;
    }
    const runExecute = execute as (args: unknown, options: unknown) => unknown;
    normalized[name] = {
      ...t,
      execute: (args: unknown, options: unknown) => {
        // Called on the tool it came from, so a tool set may write `execute` as
        // a method reaching sibling state through `this`.
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
  return normalized;
};
