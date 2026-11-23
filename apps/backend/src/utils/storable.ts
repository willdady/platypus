import { logger } from "../logger.ts";

export const storable = <T>(value: T): T => {
  if (typeof value === "string") {
    const stored = value.replaceAll("\u0000", "").toWellFormed();
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
    const { toJSON } = value as { toJSON?: unknown };
    if (typeof toJSON === "function") {
      return storable((toJSON as () => unknown).call(value)) as T;
    }
    const entries = Object.entries(value).map(
      ([key, entry]) => [storable(key), storable(entry)] as const,
    );
    const seen = new Set<string>();
    let dropped = false;
    for (const [key] of entries) {
      if (seen.has(key)) dropped = true;
      seen.add(key);
    }
    if (dropped) {
      logger.warn({}, "Dropped a value because of a key collision");
    }
    return Object.fromEntries(entries) as T;
  }
  return value;
};

export const sliceWhole = (text: string, end: number): string =>
  text.slice(0, /[\uD800-\uDBFF]/.test(text.charAt(end - 1)) ? end - 1 : end);
