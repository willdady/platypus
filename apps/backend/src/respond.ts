import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

/**
 * Sends a route's response, checking it against the exported schema that
 * describes it when running under test.
 *
 * The check is the point: a route that drops a required field, or whose read
 * model starts emitting a different shape, fails the test that exercises it
 * rather than drifting until the frontend trips over it. Production sends the
 * value untouched — validation is a test-time guard, not a per-request cost.
 *
 * The parsed value is deliberately discarded: the caller's value is what goes
 * over the wire, so extra columns a route passes through survive and a test
 * observes the real response body.
 */
export const respond = <S extends z.ZodType>(
  c: Context,
  schema: S,
  value: unknown,
  status?: ContentfulStatusCode,
) => {
  if (process.env.NODE_ENV === "test") {
    const result = schema.safeParse(value);
    if (!result.success) {
      throw new Error(
        `Response does not match its schema: ${z.prettifyError(result.error)}`,
      );
    }
  }
  return status === undefined
    ? c.json(value as never)
    : c.json(value as never, status);
};
