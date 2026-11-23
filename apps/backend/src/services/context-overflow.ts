import { APICallError, RetryError } from "ai";

export const isContextOverflowError = (error: unknown): boolean =>
  RetryError.isInstance(error)
    ? isContextOverflowError(error.lastError)
    : APICallError.isInstance(error) &&
      [400, 413, 422].includes(error.statusCode ?? 0) &&
      CONTEXT_OVERFLOW_PATTERN.test(
        `${error.message} ${error.responseBody ?? ""}`,
      );

const CONTEXT_OVERFLOW_PATTERN =
  /context[ _]length|context_length_exceeded|context window|prompt is too long|maximum context length|exceeds the (?:maximum|max)(?: number of)? (?:input )?tokens|input is too long/i;
