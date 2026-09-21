import pino from "pino";
import {
  findIssues,
  formatIssues,
  truncate,
  type ZodLikeIssue,
} from "./zod-issues.ts";

/**
 * How errors are written to the log.
 *
 * `pino.stdSerializers.errWithCause` already walks the `cause` chain, names
 * each link and copies its diagnostic properties; what it does not do is cap
 * any of it, so one rejected prompt containing Drizzle `Date` values wrote
 * 1.28 MB for a single failed generation (issue #414). It also skips zod's
 * non-enumerable `issues`, the one part of a validation failure worth reading.
 * `capLink` puts a ceiling on every link and reattaches the issues.
 */

/** Enough to identify a failure; past this a message is a payload, not prose. */
const MAX_MESSAGE_LENGTH = 512;
/** Roughly a dozen frames — where it surfaced, not the whole call graph. */
const MAX_STACK_LENGTH = 1024;
/** A property bigger than this is being carried, not described. */
const MAX_PROPERTY_LENGTH = 512;
/** Wrapped errors nest a few deep; past this something is looping. */
const MAX_CAUSE_DEPTH = 5;

/** Rendered in place of anything the caps removed, so a cut is never silent. */
export const omitted = (characters: number) =>
  `[omitted: ${characters} characters]`;

/**
 * The tail an SDK validation error appends: the rejected value, then the
 * serialized `ZodError`. Both are reproduced better elsewhere in the entry —
 * the value as a size, the issues as leaf paths. Only stripped from links that
 * wrap a Zod failure, so an ordinary message containing "Value:" keeps its tail.
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

/**
 * Cap one serialized link and its chain.
 *
 * A node carries `raw`, the error it came from — where the non-enumerable
 * `issues` still live. Anything without `raw` is a plain property, measured
 * rather than walked. Only the outermost stack survives, and a zod summary
 * replaces a message that is itself the union search tree.
 */
const capLink = (node: unknown, depth: number): unknown => {
  if (typeof node === "string") return truncate(node, MAX_MESSAGE_LENGTH);
  if (node === null || typeof node !== "object") return node;

  const raw = (node as { raw?: Record<string, unknown> }).raw;
  if (raw === undefined) {
    const encoded = safeStringify(node);
    if (encoded === undefined) return "[unserializable]";
    return encoded.length > MAX_PROPERTY_LENGTH
      ? omitted(encoded.length)
      : node;
  }

  const link = node as { message?: unknown; cause?: unknown };
  const issues = Array.isArray(raw.issues)
    ? (raw.issues as ZodLikeIssue[])
    : undefined;
  const summary = issues?.length ? formatIssues(issues) : "";
  const message =
    typeof link.message === "string" && findIssues(raw) !== undefined
      ? link.message.replace(VALIDATOR_DETAIL, "").trim()
      : link.message;

  const entry: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "issues" || key === "cause" || key === "message") continue;
    if (key === "stack" && depth > 0) continue;
    entry[key] =
      key === "stack" && typeof value === "string"
        ? truncate(value, MAX_STACK_LENGTH)
        : capLink(value, depth);
  }
  if (summary) entry.issues = summary;
  else if (typeof message === "string" && message)
    entry.message = truncate(message, MAX_MESSAGE_LENGTH);

  const cause = link.cause ?? raw.cause;
  // The standard serializer omits an error-like cause it has already walked,
  // so an error-like `raw.cause` with no serialized counterpart is a cycle.
  const circular =
    link.cause === undefined &&
    typeof (cause as { message?: unknown } | undefined)?.message === "string";
  if (cause != null) {
    entry.cause =
      depth >= MAX_CAUSE_DEPTH
        ? `[omitted: cause chain deeper than ${MAX_CAUSE_DEPTH} links]`
        : circular
          ? "[circular]"
          : capLink(cause, depth + 1);
  }
  return entry;
};

/**
 * Pino serializer for logged errors, registered for both the `error` and `err`
 * keys so an entry reads the same whichever the call site used. Non-objects
 * pass through untouched — a thrown string is already its own description.
 */
export const serializeLoggedError = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") return value;
  return capLink(pino.stdSerializers.errWithCause(value as Error), 0);
};

/**
 * The registration the logger installs. Both keys are in use across the
 * backend, and registering `err` deliberately displaces pino's standard error
 * serializer, whose uncapped `cause` walk is the larger half of what this
 * replaces. Exported as a map so the pairing can be asserted without building a
 * logger.
 */
export const errorSerializers = {
  error: serializeLoggedError,
  err: serializeLoggedError,
};
