import type { Tool } from "ai";
import { logger } from "../logger.ts";

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
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- JSON.stringify returns undefined for a function or symbol, though typed string
  if (json === undefined) return value;
  return JSON.parse(json);
};

/**
 * The most characters one tool result may carry, measured as the text a model
 * is sent: the string itself, or its JSON. Twice `read_url`'s page, so a full
 * page with its metadata and JSON escaping fits uncut.
 */
export const MAX_TOOL_RESULT_CHARS = 200_000;

/**
 * Appended to a result cut at {@link MAX_TOOL_RESULT_CHARS}. Persisted, unlike
 * the Tool-result clearing marker, so the User reads it too. Like that marker
 * it says nothing about re-running the tool: the same call returns the same
 * oversized result and is cut the same way.
 */
export const truncatedToolResultMarker = (length: number): string =>
  `[truncated: this tool result was ${length} characters long; only the first ${MAX_TOOL_RESULT_CHARS} were kept.]`;

/**
 * A result over {@link MAX_TOOL_RESULT_CHARS}, cut to its first that many
 * characters of text and followed by the truncation marker. A result within
 * the limit is returned as it was.
 */
export const capToolResult = (value: unknown, toolName: string): unknown => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- JSON.stringify returns undefined for a function or symbol, though typed string
  if (text === undefined || text.length <= MAX_TOOL_RESULT_CHARS) return value;
  logger.warn(
    { toolName, length: text.length, limit: MAX_TOOL_RESULT_CHARS },
    "Tool result truncated",
  );
  // Never split a surrogate pair: Postgres rejects the lone half in `jsonb`,
  // and the cut result is persisted.
  let end = MAX_TOOL_RESULT_CHARS;
  if (/[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end--;
  return `${text.slice(0, end)}\n${truncatedToolResultMarker(text.length)}`;
};

/**
 * Wrap every tool in a map so `transform` is applied to its result on the way
 * back to the model.
 *
 * The async-iterable path is exempt: its yields are streamed UI parts, not the
 * value fed to the model.
 */
const mapToolResults = (
  tools: Record<string, Tool>,
  transform: (result: unknown, toolName: string) => unknown,
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
        // Called on the tool it came from, so a tool set may write `execute` as
        // a method reaching sibling state through `this`.
        const result = runExecute.call(t, args, options);
        if (
          result != null &&
          typeof (result as { then?: unknown }).then === "function"
        ) {
          return (result as Promise<unknown>).then((r) => transform(r, name));
        }
        if (
          result != null &&
          typeof (result as Record<symbol, unknown>)[Symbol.asyncIterator] ===
            "function"
        ) {
          return result;
        }
        return transform(result, name);
      },
    };
  }
  return wrapped;
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
 */
export const normalizeToolResults = (
  tools: Record<string, Tool>,
): Record<string, Tool> => mapToolResults(tools, normalizeToolResult);

/**
 * Wrap every tool in a map so its result is capped at
 * {@link MAX_TOOL_RESULT_CHARS} (issue #1618).
 *
 * Unlike {@link normalizeToolResults} this covers the tools core builds too: a
 * size bound is a guarantee about every result, whoever owns its shape. Applied
 * where every run's model arguments are assembled — `buildModelInvocation` — so
 * the cut form is what the next step receives and what a Chat persists.
 */
export const capToolResults = (
  tools: Record<string, Tool>,
): Record<string, Tool> => mapToolResults(tools, capToolResult);
