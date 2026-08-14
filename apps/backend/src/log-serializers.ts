import {
  findIssues,
  formatIssues,
  truncate,
  type ZodLikeIssue,
} from "./zod-issues.ts";

/**
 * How errors are written to the log.
 *
 * Pino's default treatment of an error is either too little or too much. Under
 * a key that is not the configured `errorKey`, `message` and `stack` are
 * non-enumerable and vanish, leaving `{name, cause}`. Under `err`, the standard
 * serializer walks the whole `cause` chain with a stack per link. Neither caps
 * anything, so one rejected prompt containing Drizzle `Date` values wrote 320 KB
 * — or 1.28 MB under `err` — for a single failed generation (issue #414).
 *
 * This serializer keeps the identifying parts of every link in the chain and
 * puts a ceiling on each of them.
 */

/** Enough to identify a failure; past this a message is a payload, not prose. */
const MAX_MESSAGE_LENGTH = 512;
/** Roughly a dozen frames — where it surfaced, not the whole call graph. */
const MAX_STACK_LENGTH = 1024;
/** A property bigger than this is being carried, not described. */
const MAX_PROPERTY_LENGTH = 512;
/** Wrapped errors nest a few deep; past this something is looping. */
const MAX_CAUSE_DEPTH = 5;

/**
 * Rendered in place of anything the caps removed, so a cut is never silent.
 *
 * Counts characters rather than bytes: it comes from a JSON string's `length`,
 * and an operator comparing the number against a cap should see the same unit
 * the cap is expressed in.
 */
export const omitted = (characters: number) =>
  `[omitted: ${characters} characters]`;

/** Fields this serializer renders itself; anything else is an extra. */
const HANDLED = new Set(["name", "message", "stack", "cause", "issues"]);

/**
 * The tail an SDK validation error appends: the rejected value, then the
 * serialized `ZodError`. Both are reproduced better elsewhere in the entry —
 * the value as a size, the issues as leaf paths — and together they are the
 * bulk of the bytes. Only stripped from links that actually wrap a Zod failure,
 * so an ordinary message that happens to contain "Value:" keeps its tail.
 */
const VALIDATOR_DETAIL = /\s*(?:Value:|Error message:)[\s\S]*$/;

/** JSON, or nothing — a value that can't be rendered must not take the log
 *  call down with it. */
export const safeStringify = (value: unknown): string | undefined => {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
};

/** Keep a property if it describes the failure; replace it if it carries one. */
const serializeProperty = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") {
    return typeof value === "string"
      ? truncate(value, MAX_PROPERTY_LENGTH)
      : value;
  }
  const encoded = safeStringify(value);
  if (encoded === undefined) return "[unserializable]";
  return encoded.length > MAX_PROPERTY_LENGTH ? omitted(encoded.length) : value;
};

const serializeLink = (
  value: object,
  depth: number,
  seen: Set<object>,
): unknown => {
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  const source = value as Record<string, unknown>;
  const entry: Record<string, unknown> = {
    type: value.constructor?.name ?? "object",
  };

  // Both read by property access, not enumeration: zod defines `issues`
  // non-enumerably, which is why it never reached the log before. `wrapsZod`
  // covers the whole chain, `ownIssues` only this link.
  const ownIssues = Array.isArray(source.issues)
    ? (source.issues as ZodLikeIssue[])
    : undefined;
  const wrapsZod = findIssues(value, 0) !== undefined;

  // Computed before the message so the message can be kept when this comes back
  // empty. Suppressing the message on the mere *presence* of issues would let a
  // tree that summarises to nothing take the only readable line with it.
  const summary =
    ownIssues && ownIssues.length > 0 ? formatIssues(ownIssues) : "";

  if (typeof source.message === "string") {
    const message = wrapsZod
      ? source.message.replace(VALIDATOR_DETAIL, "").trim()
      : source.message;
    // A ZodError's own message *is* the union search tree, so a summary
    // replaces it rather than sitting alongside it.
    if (message && !summary) {
      entry.message = truncate(message, MAX_MESSAGE_LENGTH);
    }
  }

  // Only the outermost stack: the inner links are named by type and message,
  // and a stack per link is what makes the standard serializer so large.
  if (depth === 0 && typeof source.stack === "string") {
    entry.stack = truncate(source.stack, MAX_STACK_LENGTH);
  }

  for (const key of Object.keys(source)) {
    if (HANDLED.has(key)) continue;
    entry[key] = serializeProperty(source[key]);
  }

  if (summary) entry.issues = summary;

  const cause = source.cause;
  if (cause != null) {
    entry.cause =
      depth >= MAX_CAUSE_DEPTH
        ? `[omitted: cause chain deeper than ${MAX_CAUSE_DEPTH} links]`
        : typeof cause === "object"
          ? serializeLink(cause, depth + 1, seen)
          : serializeProperty(cause);
  }

  return entry;
};

/**
 * Pino serializer for logged errors, registered for both the `error` and `err`
 * keys so an entry reads the same whichever the call site used.
 *
 * Non-objects pass through untouched — a thrown string is already its own
 * description.
 */
export const serializeLoggedError = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") return value;
  return serializeLink(value, 0, new Set());
};

/**
 * The serializer registration the logger installs.
 *
 * Both keys are in use across the backend and an error is as likely to arrive
 * under either, so an entry has to read the same whichever the call site chose.
 * Registering `err` deliberately displaces pino's standard error serializer,
 * whose uncapped `cause` walk is the larger half of what this replaces.
 *
 * Exported as a map rather than wired inline so the pairing can be asserted
 * without constructing a logger and its transport.
 */
export const errorSerializers = {
  error: serializeLoggedError,
  err: serializeLoggedError,
};
