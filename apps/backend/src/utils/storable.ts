import { logger } from "../logger.ts";

/**
 * A JSON-compatible value made storable in a Postgres `jsonb` column, which
 * rejects two kinds of string content: NUL, removed here, and a lone UTF-16
 * surrogate, replaced with U+FFFD; each changed string is logged. Applied to every string, object keys
 * included; a value with `toJSON` is replaced by its result, as
 * `JSON.stringify` would; everything else is returned unchanged.
 */
export const storable = <T>(value: T): T => {
  if (typeof value === "string") {
    const stored = value.replaceAll("\u0000", "").toWellFormed();
    // Never silent: the stored text differs from what the tool or model sent.
    if (stored !== value) {
      logger.warn(
        { length: value.length, storedLength: stored.length },
        "Removed NUL or replaced a lone surrogate before storing",
      );
    }
    return stored as T;
  }
  if (Array.isArray(value)) return value.map(storable) as T;
  if (typeof value === "object" && value !== null) {
    // What `JSON.stringify` would write, e.g. a Date's ISO string.
    const { toJSON } = value as { toJSON?: unknown };
    if (typeof toJSON === "function") {
      return storable((toJSON as () => unknown).call(value)) as T;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        storable(key),
        storable(entry),
      ]),
    ) as T;
  }
  return value;
};

/**
 * The first `end` UTF-16 units of `text`, one fewer when the cut would split a
 * surrogate pair: the lone half left behind is rejected by `jsonb`.
 */
export const sliceWhole = (text: string, end: number): string =>
  text.slice(0, /[\uD800-\uDBFF]/.test(text.charAt(end - 1)) ? end - 1 : end);
