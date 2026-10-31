import { APICallError, RetryError } from "ai";

/**
 * Whether an error is a Provider's "the request is too big for this model's
 * context" rejection: what a Transcript summary pass (ADR-0041) retries on with
 * an earlier anchor, what a Drive's overflow recovery retries once after a tool
 * step, and what the User is told is a conversation too long for the model
 * (issue #1717). Each phrasing is pinned by a vendor fixture in the test.
 *
 * Tight on purpose: only a request rejected for being too large names a
 * context window or an input-length bound, so the match doubles as the proof
 * that the retry's narrower range is responsive to what the Provider said.
 * A broad 400 that happens to contain "context" in a span of free text is
 * not enough — the status codes are the gateways' own, and the pattern names
 * the two shapes the vendors actually use.
 */
export const isContextOverflowError = (error: unknown): boolean =>
  // The SDK's backoff wraps a call that failed retryably and then overflowed
  // in a `RetryError`; its last attempt is what the Provider said.
  RetryError.isInstance(error)
    ? isContextOverflowError(error.lastError)
    : APICallError.isInstance(error) &&
      [400, 413, 422].includes(error.statusCode ?? 0) &&
      CONTEXT_OVERFLOW_PATTERN.test(
        `${error.message} ${error.responseBody ?? ""}`,
      );

const CONTEXT_OVERFLOW_PATTERN =
  /context[ _]length|context_length_exceeded|context window|prompt is too long|maximum context length|exceeds the (?:maximum|max)(?: number of)? (?:input )?tokens|input is too long/i;
