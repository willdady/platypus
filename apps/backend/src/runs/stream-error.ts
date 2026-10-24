import {
  APICallError,
  InvalidToolInputError,
  LoadAPIKeyError,
  NoSuchToolError,
} from "ai";
import { logger } from "../logger.ts";
import {
  formatIssues,
  findIssues,
  MAX_ISSUE_LENGTH,
  truncate,
  type ZodLikeIssue,
} from "../zod-issues.ts";

/** The unified finish reason the SDK reports for an output-budget cutoff. */
export const isTruncatedByTokenLimit = (
  finishReason: string | undefined,
): boolean => finishReason === "length";

/**
 * The model meant to keep going: it ended the step by asking for tool calls, so
 * there was more of the turn left to run.
 *
 * On a *terminal* finish that can only happen because something stopped the
 * loop — every Tool Platypus serves executes server-side, so no turn ends
 * legitimately waiting on a caller to run one. Necessary but not sufficient for
 * naming a step-ceiling stop: the no-progress detector halts an unattended run
 * on this same reason, below the ceiling, so the step count has to agree.
 *
 * A named sibling of the predicate above rather than a string comparison at the
 * emission point: both readings of a finish reason live in one module, where a
 * change to what the SDK reports has one place to be made. Module-private
 * because nothing outside wants half the rule — callers take
 * {@link stoppedAtStepCeiling}, which is the whole of it.
 */
const intendedToContinue = (finishReason: string | undefined): boolean =>
  finishReason === "tool-calls";

/**
 * The whole two-part rule for "the step ceiling stopped this loop", in one
 * place: the model asked to continue, and the turn had no steps left to give it.
 *
 * Both halves are required and neither is sufficient. The finish reason alone
 * mislabels any other stop condition that halts a tool loop — a no-progress
 * abort ends on the same reason, below the ceiling. The step count alone flags a
 * turn whose last allowed step happened to be its answer, which was never cut
 * short.
 *
 * Stated once because two paths read it from different sources: the streamed
 * extractor counts the per-step finish parts it sees, and the headless drive
 * reads the step count off the computed statistics. A rule written twice is a
 * rule that drifts. Deciding a *tripped no-progress detector* owns the stop
 * instead is the caller's — this predicate never sees one.
 *
 * `stepCeiling` is optional so a caller with no ceiling to give reports nothing
 * rather than guessing one.
 */
export const stoppedAtStepCeiling = ({
  finishReason,
  steps,
  stepCeiling,
}: {
  finishReason: string | undefined;
  steps: number;
  stepCeiling?: number;
}): boolean =>
  stepCeiling !== undefined &&
  steps >= stepCeiling &&
  intendedToContinue(finishReason);

const describeValidationFailure = (error: InvalidToolInputError): string => {
  const issues = findIssues(error.cause);
  if (issues) return formatIssues(issues);
  // No structured issues to unpack — fall back to the cause's own text,
  // capped, which is still better than the full SDK message.
  const cause = error.cause;
  const message =
    cause instanceof Error ? cause.message : stringify(cause ?? "unknown");
  return truncate(message.replace(/\s+/g, " ").trim(), MAX_ISSUE_LENGTH);
};

/**
 * The same failure, arriving as a string instead of an `Error`.
 *
 * The streaming path never hands us the instance: an invalid tool call becomes
 * a `tool-error` stream part whose `error` is `getErrorMessage(cause)` — which
 * is `error.toString()` — and that string is what reaches `onError`. So the
 * `isInstance` branches below cannot fire for the case this issue is about, and
 * without this the real production failure lands in the generic fallback.
 *
 * Matching on the SDK's message format is unavoidably coupled to that format.
 * It degrades safely: an unrecognised shape falls through to returning the
 * string unchanged, which is still better than discarding it.
 */
const TOOL_INPUT_MESSAGE =
  /^(?:AI_)?InvalidToolInputError: Invalid input for tool (\S+?):\s*([\s\S]*)$/;
/** The SDK appends the serialized ZodError after this marker. */
const ISSUES_MARKER = "Error message:";

const describeStringifiedToolInputError = (
  text: string,
): string | undefined => {
  const match = TOOL_INPUT_MESSAGE.exec(text);
  if (!match) return undefined;
  const [, toolName, detail] = match;
  if (toolName === undefined || detail === undefined) return undefined;

  const markerAt = detail.lastIndexOf(ISSUES_MARKER);
  if (markerAt !== -1) {
    try {
      const parsed: unknown = JSON.parse(
        detail.slice(markerAt + ISSUES_MARKER.length).trim(),
      );
      if (Array.isArray(parsed) && parsed.length > 0) {
        return `Invalid input for tool "${toolName}": ${formatIssues(parsed as ZodLikeIssue[])}`;
      }
    } catch {
      // Fall through to the capped detail below.
    }
  }
  // Strip the echoed value, which is the bulk of the SDK's message.
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- a detail that is all value keeps the whole
  const withoutValue = detail.split(/Value:/)[0] || detail;
  return `Invalid input for tool "${toolName}": ${truncate(
    withoutValue.replace(/\s+/g, " ").trim(),
    MAX_ISSUE_LENGTH,
  )}`;
};

/**
 * Converts AI SDK errors into user-facing strings for the UI message stream.
 *
 * The text produced here reaches both the user and, on a failed step, the
 * model — so it has to be short enough to read and specific enough to act on.
 *
 * Pure, and separate from {@link formatStreamError}, so a caller that is not
 * rendering a stream failure gets the same wording without a spurious "Chat
 * stream error" log line. Naming why a sub-agent could not be built is the
 * other caller: what fails there is a Provider being opened, so the cases this
 * recognises — a missing API key, a 401, a rate limit — are exactly its causes.
 */
export const describeSdkError = (error: unknown): string => {
  if (LoadAPIKeyError.isInstance(error)) {
    return "AI provider API key is missing or not configured.";
  }
  if (APICallError.isInstance(error)) {
    if (error.statusCode === 401 || error.statusCode === 403) {
      return "AI provider authentication failed. Your API key may be invalid or expired.";
    }
    if (error.statusCode === 429) {
      return "AI provider rate limit exceeded. Please try again later.";
    }
    if (error.statusCode != null && error.statusCode >= 500) {
      return "AI provider is currently unavailable. Please try again later.";
    }
    return `AI provider error: ${error.message}`;
  }
  // Checked before the generic `Error` branch: both of these ARE Errors, so
  // without this they fall through to `error.message` — which for an invalid
  // tool input is the unreadable wall of validator output.
  if (InvalidToolInputError.isInstance(error)) {
    return `Invalid input for tool "${error.toolName}": ${describeValidationFailure(error)}`;
  }
  if (NoSuchToolError.isInstance(error)) {
    return `The tool "${error.toolName}" does not exist and cannot be called.`;
  }
  // The streaming path stringifies tool-call failures before they reach here,
  // so the same two cases have to be recognised again in text form.
  if (typeof error === "string") {
    const asToolInput = describeStringifiedToolInputError(error);
    if (asToolInput) return asToolInput;
    const noSuchTool = /^(?:AI_)?NoSuchToolError:\s*([\s\S]*)$/.exec(
      error,
    )?.[1];
    if (noSuchTool !== undefined) {
      return truncate(noSuchTool.replace(/\s+/g, " ").trim(), MAX_ISSUE_LENGTH);
    }
    // Any other string is returned as-is: it used to be discarded entirely in
    // favour of the generic fallback, which is how the reported failure lost
    // the one sentence that named its cause.
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  // The reported failure landed here and the runtime type was never captured,
  // which is why nobody could tell what had actually been thrown.
  return `An unexpected error occurred (received ${describeNonError(error)}).`;
};

/**
 * {@link describeSdkError}, plus the log line every stream failure earns.
 * This is what `toUIMessageStream`'s `onError` is wired to on every run.
 */
export const formatStreamError = (error: unknown): string => {
  logger.error({ error }, "Chat stream error");
  return describeSdkError(error);
};

/**
 * Render an unknown value as text without ever producing "[object Object]",
 * which is the failure mode this whole branch exists to avoid.
 */
const stringify = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "symbol"
  ) {
    return value.toString();
  }
  if (typeof value === "function")
    return `function ${value.name || "anonymous"}`;
  try {
    return (
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- JSON.stringify returns undefined for a function or symbol, though typed string
      JSON.stringify(value) ?? String(value === null ? "null" : "undefined")
    );
  } catch {
    return "[unserializable]";
  }
};

/** Identify a non-`Error` throw well enough to recognise it in a bug report. */
const describeNonError = (value: unknown): string => {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "object") {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- an Object.create(null) value has no constructor, though typed as having one
    const name = value.constructor?.name ?? "object";
    return truncate(`${name} ${stringify(value)}`, MAX_ISSUE_LENGTH);
  }
  return truncate(`${typeof value} ${stringify(value)}`, MAX_ISSUE_LENGTH);
};
