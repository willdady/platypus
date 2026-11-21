/**
 * A JSON-compatible value made storable in a Postgres `jsonb` column, which
 * rejects two kinds of string content: NUL, removed here, and a lone UTF-16
 * surrogate, replaced with U+FFFD. Applied to every string, object keys
 * included; a value with `toJSON` is replaced by its result, as
 * `JSON.stringify` would; everything else is returned unchanged.
 */
export const storable = <T>(value: T): T => {
  if (typeof value === "string") {
    return value.replaceAll("\u0000", "").toWellFormed() as T;
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
