import pino from "pino";
import {
  findIssues,
  formatIssues,
  truncate,
  type ZodLikeIssue,
} from "./zod-issues.ts";

const MAX_MESSAGE_LENGTH = 512;
const MAX_STACK_LENGTH = 1024;
const MAX_PROPERTY_LENGTH = 512;
const MAX_CAUSE_DEPTH = 5;

export const omitted = (characters: number) =>
  `[omitted: ${characters} characters]`;

const VALIDATOR_DETAIL = /\s*(?:Value:|Error message:)[\s\S]*$/;

export const safeStringify = (value: unknown): string | undefined => {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
};

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
  // why: errWithCause omits a cause it already walked, so an unserialized error-like cause is a cycle
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

export const serializeLoggedError = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") return value;
  return capLink(pino.stdSerializers.errWithCause(value as Error), 0);
};

export const errorSerializers = {
  error: serializeLoggedError,
  err: serializeLoggedError,
  cause: serializeLoggedError,
};
