import { APICallError } from "ai";

/**
 * Whether an error is a Provider's "the request is too big for this model's
 * context" rejection — the one failure a Transcript summary pass (ADR-0041)
 * retries on with an earlier anchor, and the phrasing issue #1263 pins from
 * captured Provider fixtures.
 *
 * Tight on purpose: only a request rejected for being too large names a
 * context window or an input-length bound, so the match doubles as the proof
 * that the retry's narrower range is responsive to what the Provider said.
 * A broad 400 that happens to contain "context" in a span of free text is
 * not enough — the status codes are the gateways' own, and the pattern names
 * the two shapes the vendors actually use.
 */
export const checkContextOverflow = (error: unknown): boolean =>
  APICallError.isInstance(error) &&
  [400, 413, 422].includes(error.statusCode ?? 0) &&
  CONTEXT_OVERFLOW_PATTERN.test(`${error.message} ${error.responseBody ?? ""}`);

const CONTEXT_OVERFLOW_PATTERN =
  /context[ _]length|context_length_exceeded|context window|prompt is too long|maximum context length|exceeds the (?:maximum|max)(?: number of)? (?:input )?tokens|input is too long/i;
