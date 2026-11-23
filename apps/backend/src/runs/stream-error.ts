import {
  APICallError,
  InvalidToolInputError,
  LoadAPIKeyError,
  NoSuchToolError,
} from "ai";
import { logger } from "../logger.ts";
import { isContextOverflowError } from "../services/context-overflow.ts";
import { TOOL_RESULT_TOO_LARGE } from "./context-overflow-recovery.ts";
import {
  formatIssues,
  findIssues,
  MAX_ISSUE_LENGTH,
  truncate,
  type ZodLikeIssue,
} from "../zod-issues.ts";

export const isTruncatedByTokenLimit = (
  finishReason: string | undefined,
): boolean => finishReason === "length";

const intendedToContinue = (finishReason: string | undefined): boolean =>
  finishReason === "tool-calls";

export const stoppedAtStepCeiling = ({
  finishReason,
  steps,
  stepCeiling,
}: {
  finishReason: string | undefined;
  steps: number;
  stepCeiling: number;
}): boolean => steps >= stepCeiling && intendedToContinue(finishReason);

const describeValidationFailure = (error: InvalidToolInputError): string => {
  const issues = findIssues(error.cause);
  if (issues) return formatIssues(issues);
  const cause = error.cause;
  const message =
    cause instanceof Error ? cause.message : stringify(cause ?? "unknown");
  return truncate(message.replace(/\s+/g, " ").trim(), MAX_ISSUE_LENGTH);
};

const TOOL_INPUT_MESSAGE =
  /^(?:AI_)?InvalidToolInputError: Invalid input for tool (\S+?):\s*([\s\S]*)$/;
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
      // why: issue JSON that won't parse falls through to the capped detail, never a throw
    }
  }
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- a detail that is all value keeps the whole
  const withoutValue = detail.split(/Value:/)[0] || detail;
  return `Invalid input for tool "${toolName}": ${truncate(
    withoutValue.replace(/\s+/g, " ").trim(),
    MAX_ISSUE_LENGTH,
  )}`;
};

export const CONTEXT_OVERFLOW_MESSAGE =
  "This conversation is too long for the model's context window. Start a new Chat, or switch to a model with a larger context window.";

export const describeSdkError = (error: unknown): string => {
  if (isContextOverflowError(error)) return CONTEXT_OVERFLOW_MESSAGE;
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
  if (InvalidToolInputError.isInstance(error)) {
    return `Invalid input for tool "${error.toolName}": ${describeValidationFailure(error)}`;
  }
  if (NoSuchToolError.isInstance(error)) {
    return `The tool "${error.toolName}" does not exist and cannot be called.`;
  }
  if (typeof error === "string") {
    const asToolInput = describeStringifiedToolInputError(error);
    if (asToolInput) return asToolInput;
    const noSuchTool = /^(?:AI_)?NoSuchToolError:\s*([\s\S]*)$/.exec(
      error,
    )?.[1];
    if (noSuchTool !== undefined) {
      return truncate(noSuchTool.replace(/\s+/g, " ").trim(), MAX_ISSUE_LENGTH);
    }
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return `An unexpected error occurred (received ${describeNonError(error)}).`;
};

export const formatStreamError = (error: unknown): string => {
  if (error === TOOL_RESULT_TOO_LARGE) return error;
  logger.error({ error }, "Chat stream error");
  return describeSdkError(error);
};

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
